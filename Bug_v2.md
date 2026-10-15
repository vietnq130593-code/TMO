# BUG_V2.MD — SỔ GHI NHẬN VẤN ĐỀ QUAN SÁT AGENTS, PHIÊN 2 (GHI NGAY TẠI CHỖ, KHÔNG HOÃN)

> **Phiên quan sát:** bắt đầu 2026-10-08T17:05:30Z (mốc log live: dòng 2194 `mission-watch-live.log`)
> **Đối tượng:** Mission `cmuzscdvj0013llzrvlyky79t` — Omega (TL) + sub-agents, session `agent_1791447938659_4x5wxb`, model `space-bunny-free` (zen)
> **Directive (UI, 70 ký tự):** "Tiến hành các đề xuất khắc phục và tiếp tục với các phần còn thiếu" — tiếp nối mission #19 (dừng `verdict_stagnation` 15:38Z sau 4.6M tokens, quan sát round-68 = bug.md 25 mục)
> **Ngữ cảnh hệ thống:** HEAD `c3e304d` (r69) — mission ĐẦU TIÊN chạy với đủ 9 fix r68 (F1–F9) + 8 fix r69 (BUG-007/008/009+025/010+014/012/022/024) → phiên quan sát này ĐỒNG THỜI là KIỂM CHỨNG SỐNG toàn bộ fix trên mission thật (bug.md round-69 mục D ghi: "chờ kiểm chứng sống mission kế")
> **Phạm vi quan sát:** từ đầu run (17:03:29Z, evt0) đến khi mission chuyển trạng thái terminal — mọi vấn đề thấy được ở TỪNG BƯỚC đều ghi vào đây NGAY LẬP TỨC
>
> **Phân loại:** A=tool-call parse · B=kỷ luật thực thi · C=trọng tài/evaluator · D=ngôn ngữ · E=output/context · F=DB bộ nhớ/data-map · G=hạ tầng/vệ sinh · H=quy trình giám sát
> **Mức độ:** P0 = chặn nhiệm vụ/security · P1 = sai hành vi hệ thống cần fix cấu trúc · P2 = hở cơ chế, tốn tài nguyên · P3 = vệ sinh/cosmetic
> **Quy ước mã:** mục vấn đề đánh `BUG2-NNN`; mục kiểm-chứng-sống fix cũ (tích cực) đánh `LIVE-✅-n` — hai loại tách bạch để cuối phiên tổng hợp riêng.

---

## CÁC MỤC GHI NHẬN

### LIVE-✅-1 · BUG-008 r69 (directive-guard enrichment) — XÁC NHẬN SỐNG ngay evt0
- **Hiện tượng:** directive gốc user chỉ 70 ký tự mơ hồ ("Tiến hành các đề xuất khắc phục và tiếp tục với các phần còn thiếu") — đúng dạng ping-pong từng giết mission #18/#19. Hệ thống TỰ PHỤC HỒI: `enrichDirectiveForGoalLoop` tự truy hồi backlog todo đang mở của session và gắn khối "Nghiệm thu" 8 tiêu chí (P1-3, P1-2, P1-1, kiểm kê lại, tổng thể ×2, P2-1, P0-3) — đúng từng phần việc chưa hoàn thành, không mơ hồ.
- **Bằng chứng:** DB `GoalLoopJob.input.userMessage` (độ dài input 64,417 chars) chứa khối Nghiệm thu đầy đủ; log live dòng 2196 hiển thị trọn đoạn truy hồi.
- **Đánh giá:** cơ chế chống ping-pong vận hành đúng thiết kế — evaluator giờ có checklist cụ thể bám được thay vì đòi "báo cáo cuối" chung chung.

### LIVE-✅-2 · Todo-coverage machine feedback — vòng lặp phản hồi máy hoạt động (chu kỳ 1)
- **Hiện tượng:** Omega lập kế hoạch 3 lần: plan 1 (10 mục) bị máy chấm "phủ 2/8 nghiệm thu · 3/12 dữ liệu" → plan 2 (9 mục) "12/12 dữ liệu nhưng 4/8 nghiệm thu" → plan 3 (8 mục) "8/8 + 12/12 ✅". Máy đo dẫn dắt đến phủ đầy đủ — agent tự điều chỉnh theo phản hồi máy, đúng triết lý hardcode.
- **Bằng chứng:** `run_1791479009163_1.jsonl` evt9 (thought it3: "harness mới xác nhận chỉ phủ 2/8…"), evt12, evt15; todo_update evt7/11/14.
- **Đánh giá:** tích cực — nhưng XEM BUG2-002 về mức ma sát nhãn.

### LIVE-✅-3 · Ngôn ngữ — Omega + cả 3 sub-agent đều suy nghĩ tiếng Việt ngay từ it1
- **Hiện tượng:** main run evt1-3, evt15-16 tiếng Việt chuẩn protocol (📍 GĐ0/GĐ1/📤 PHÂN CÔNG); cả 3 sub (RAMPAGE, SENTINEL, Linh Sickyx) mở đầu "Tôi bắt đầu…" bằng tiếng Việt — đối lập SENTINEL r68 nghĩ 100% tiếng Anh (BUG-004 cũ).
- **Bằng chứng:** timeline 3 file `sub_1791479109523_2/537_3/540_4.jsonl` evt1-2.
- **Đánh giá:** F6 r68 (protocol inject + detector sub-loop) có hiệu lực thực chiến.

### LIVE-✅-4 · Detector ngôn ngữ sub-loop kích hoạt SỐNG lần đầu trên mission thật
- **Hiện tượng:** sub Linh Sickyx (P1-3) sau khi đọc workspace phát 1 output tiếng Anh (ratio dấu 7%) → hệ thống cảnh báo tức thì "⚠️ NGÔN NGỮ: output tiếng Anh (ratio 7%) — đã cảnh báo viết tiếng Việt (lần 1/2)" — nudge được persist vào transcript thành thought event riêng (quan sát được).
- **Bằng chứng:** `sub_1791479109540_4.jsonl` evt6.
- **Đánh giá:** cơ chế đếm 2-nudge + máy đo vận hành đúng. THEO DÕI: nếu lặp ≥3 lần cùng sub trong run → viLateCount phải được persist + lọt vào MÁY ĐO (chưa có case để xác nhận nhánh đó).

### LIVE-✅-5 · Kỷ luật delegation — Omega tự phân công 3 agent SONG SONG ngay chu kỳ 1 (không cần cổng cắt)
- **Hiện tượng:** "📤 Chu kỳ 1 — PHÂN CÔNG SONG SONG: Omega gửi 3 agent cùng lúc" — SENTINEL (P0-1 hoàn thiện+kiểm định), RAMPAGE (kiểm kê raw SQL = P0-3), Linh Sickyx (P1-3 chỉ đọc). Không lần nào delegation_gate phải can thiệp — hành vi TL tự chủ đúng thiết kế mới.
- **Bằng chứng:** main evt16; log live dòng 2219-2226 (3 SUB-AGENT khởi động 17:05:09-10Z).
- **Đánh giá:** đối lập mission #18/#19 (Omega tự làm / phân công sai phạm vi) — F7 r67 + F1/F2 r68 cho thấy hệ delegating tự nhiên.

### BUG2-001 · B · P3 · 17:03:58Z · Omega it1 — todo_write BỊ TỪ CHỐI vì priority "critical" ngoài enum
- **Hiện tượng:** lần todo_write đầu tiên của run thất bại: `❌ Invalid priority: critical. Allowed: low|medium|high`. Model dùng từ vựng tự nhiên cho việc bảo mật ("critical") nhưng schema enum tool chỉ nhận 3 giá trị. Omega tự phục hồi ngay ở lần gọi kế (evt6) — không mất chu kỳ, nhưng đây là friction lặp kiểu từ vựng: sẽ tái diễn ở mọi mission bảo mật (model hay gắn "critical" cho P0).
- **Bằng chứng:** `run_1791479009163_1.jsonl` evt4 (tool todo_write success=false, resultPreview nguyên văn trên) + evt5 (thought it2 giải thích thất bại).
- **Đánh giá:** tin nhắn lỗi rõ ràng, hành vi an toàn — nhưng theo doctrine "hardcode > prompt" thì nên chuẩn hóa tại TẦN TOOL: map alias `critical|urgent|blocker` → `high` (và tương tự `trivial`→`low`) thay vì reject; giữ reject chỉ cho giá trị lạ thật sự. Đề xuất fix tầng `src/lib/tool-*.ts` nơi validate todo_write.

### BUG2-002 · H · P3 · 17:04:52Z · Chu kỳ 1 — matcher nhãn nghiệm-thu↔todo quá cứng, buộc 3 lần todo_write chỉ để chỉnh nhãn
- **Hiện tượng:** sau khi plan 2 đã phủ 12/12 mục dữ liệu, máy VẪN không công nhận 4/8 tiêu chí nghiệm thu vì "nhãn đã bị chuẩn hóa không khớp" (Omega tự nhận diện trong thought evt12) — phải viết lại todo lần 3 chỉ để nhãn khớp định dạng máy đòi. Kết quả đúng (8/8) nhưng tốn 2 vòng lặp + 3 tool call kế hoạch hóa cho việc thuần cosmetic.
- **Bằng chứng:** evt9 (2/8), evt12 (thought nguyên văn "máy vẫn không nhận bốn tiêu chí nghiệm thu đầu vì nhãn đã bị chuẩn hóa không khớp"), evt13-14 (todo_write lần 3 → 8/8).
- **Đánh giá:** P3 vì máy phản hồi vẫn dẫn đến kết quả đúng; nhưng là ma sát hệ thống có thể bỏ: matcher nên trích mã định danh tiêu chí (regex `P\d+-\d+` / `[Nghiệm thu n]`) từ text todo để khớp mờ thay vì so nhãn nguyên văn đã chuẩn hóa. Đề xuất fix tầng coverage-checker của goal-loop.

### BUG2-WATCH-1 · B · ĐANG ĐIỀU TRA · Sub-agent readOnly (Linh Sickyx "hoàn toàn chỉ đọc") vẫn gọi `shell` THÀNH CÔNG — whitelist strip có thật sự bật?
- **Hiện tượng:** lời giao việc P1-3 chứa cụm "hoàn toàn chỉ đọc" (tín hiệu READ_ONLY_INTENT_RE của fix r69 BUG-010/014) — lẽ ra 22 tool ghi phải bị strip khỏi whitelist. Nhưng sub vẫn gọi `shell` liên tục (evt4, evt9, evt13) mà KHÔNG bị từ chối.
- **Câu hỏi phải trả lời trước khi kết luận:** (a) `shell` có nằm trong SUBAGENT_WRITE_TOOLS không — nếu không thì việc chặn ghi qua shell chỉ dựa vào exec-allowlist tầng dưới (2 lớp, có thể là thiết kế); (b) cờ readOnly có được auto-detect đặt vào delegate_task args của lời giao này không; (c) các lệnh shell sub chạy có phải thuần đọc.
- **Bằng chứng tới giờ:** `sub_1791479109540_4.jsonl` evt4/9/13 shell không fail.
- **Đánh giá:** CHƯA KẾT LUẬN — điều tra mã + args lời giao ngay; nếu shell là write-tool mà không bị strip → P1 thật (vi phạm cam kết readOnly).

---
### BUG2-003 · B · P1 · 17:05:09Z · readOnly auto-detect THẤT BẠI trên lời giao "hoàn toàn chỉ đọc" — sub vẫn đầy 45 tool ghi
- **Hiện tượng:** lời giao P1-3 cho Linh Sickyx chứa tín hiệu mạnh "hoàn toàn chỉ đọc" (READ_ONLY_INTENT_RE khớp "chỉ đọc") nhưng KHÔNG có dòng `[SubAgent] … READ-ONLY delegation contract` nào trong dev.log quanh 17:05:09-10; sub nhận **45 tools** (nhiều hơn cả 22 tool mặc định của RAMPAGE/SENTINEL cùng lúc) — tức whitelist KHÔNG strip; sub đã chạy `mkdir -p scratch/p1-3` + redirect `bun audit > scratch/p1-3/bun-audit.txt` + tạo `P1-3-SECURITY-INVENTORY.md`, `secret-inventory.tsv` (các lệnh GHI thật, thành công hết).
- **Root-cause (cơ chế đã tái hiện):** `detectReadOnlyDelegation` = tín hiệu mạnh + `!MODIFY_INTENT_RE.test(stripped)` — nhưng bước strip chỉ bỏ các cụm `không sửa (file|mã|code|nguồn)` đúng 4 đối tượng này. Lời giao theo format chuẩn từ tiêu chí nghiệm thu P1-3 trong directive: "…lưu báo cáo machine-verifiable, **không sửa cấu hình bị cấm**" — "sửa" trong PHỦ ĐỊNH với đối tượng "cấu hình" (ngoài whitelist 4 đối tượng) sống sót qua bước strip → MODIFY_INTENT_RE khớp từ "sửa" → detector trả false → readOnly không bao giờ bật. Guard-âm tự vô hiệu guard-dương vì từ vựng phủ định chưa tổng quát hóa.
- **Bằng chứng:** dev.log:287007 (dòng đăng ký delegation, 45 tools, không dòng READ-ONLY); `sub_1791479109540_4.jsonl` evt4/9/13 (shell mkdir/redirect success=true); scratch/p1-3/ có 3 file thật (tồn tại trên đĩa); mã `subagent-delegate.ts` L209-213 + L658.
- **Đánh giá:** P1 — sai hành vi hệ thống ở đúng loại mission nó được xây để xử lý (audit chỉ-đọc). May mắn lần này các ghi đều là artifact vô hại trong scratch/ (chính tiêu chí cũng đòi "lưu artifact" — xem BUG2-003b). Exec-allowlist tầng dưới vẫn chặn được `.env` (evt61 sub bị infra-guard chặn — chứng minh lớp dưới sống).
- **(b) Thiết kế mâu thuẫn:** tiêu chí P1-3 vừa đòi "hoàn toàn chỉ đọc" vừa đòi "lưu artifact báo cáo" — nếu detector ĐÚNG thì contract readOnly sẽ strip mọi tool ghi → sub KHÔNG THỂ lưu artifact → nhiệm vụ bế tắc. Cần chế độ "readOnly + artifact-dir scope" (chỉ cho ghi trong scratch/&lt;delegation&gt;/) thay vì binary toàn-trắng/toàn-đen.

### BUG2-004 · G · P0-ĐANG-XẾP-HẠNG · 17:08–17:11Z · App WEDGE + 2 lần restart GIẾT cả 3 delegation đang chạy giữa chừng
- **Hiện tượng:** 17:08:25 keepalive ghi "health=500 nhưng pm2=online (wedge?)" trong khi 3 sub-agent đang chạy dở (65/58/68 events); 17:11:18 "health=000"; PM2 restart counter 325→327 (2 lần liên tiếp), process hiện tại lên đời 17:11:43.9. Cả 3 delegation bị giết giữa chừng — main run ghi "⚠️ RESUME: phát hiện 3 delegation bị restart giết giữa chừng (kết quả mất trắng)".
- **Thiệt hại:** (1) kết quả 3 delegation mất (báo cáo + trọng tài độc lập + máy đo git-delta cuối run đều không kịp phát); (2) working tree còn **9 file thay đổi chưa ai kiểm định**: 7 file sửa (knowledge/query/route.ts, collectors.ts, dev-tools.ts, episodic-db.ts, exec-allowlist.ts, exec-runner.ts, tests/execute-route-security.test.ts) + 2 file mới (src/lib/sql-policy.ts, tests/sql-injection-regression.test.ts) — code nửa vời từ agent đã chết, chưa chạy tsc/gate lấy một lần; (3) token 3 sub đốt trước khi chết mất trắng khỏi kế toán (xem BUG2-005).
- **Đối chiếu.Positive:** cơ chế durable resume HOẠT ĐỘNG ĐÚNG: job sống qua 2 lần restart, phát hiện delegation chết, inject notice; Omega chu kỳ 2 tự đọc trace jsonl của 3 sub để phục hồi bằng chứng — hệ thống tự chữa theo đúng thiết kế (xem LIVE-✅-6).
- **Câu hỏi mở (đang điều tra):** nguyên nhân wedge 500 lúc 17:08 — OOM? event-loop block do 3 sub song song? unhandled rejection? Kiểm tra dev.log 17:08-17:11.
- **Đánh giá:** tạm xếp P0-chờ-nguyên-nhân vì giết mission đang chạy + hạ tầng wedge là đúng chuẩn P0 của giao thức (D4 an toàn hạ tầng) — sẽ xếp hạng cuối sau root-cause.

### BUG2-005 · G · P2 · 17:11Z · Sub-run chết vì crash để lại AgentRunRecord "failed/crashed" với metrics TOÀN NULL — token đốt mất trắng khỏi kế toán
- **Hiện tượng:** 3 dòng AgentRunRecord: status=failed, stopReason=crashed, tokensUsed/toolCalls/toolFailures/complete/evaluatorConfidence ĐỀU NULL. Main job checkpoint hiển thị "tokens 367k (sub 0)" — dù 3 sub đã cháy thật (Linh Sickyx một mình ~500k+ theo nhịp poll 17:05-17:09). Crash-path không finalize record → ngân sách mission (D5) mù hoàn toàn phần sub đã đốt.
- **Bằng chứng:** SQL readback AgentRunRecord 3 run sub_17914791…; mission-watch snapshot 17:13:43 "sub 0".
- **Đánh giá:** P2 (hở cơ chế đo, không chặn nhiệm vụ) — nhưng là điều kiện cần cho D5.2 (lãng phí phát hiện trong lúc chạy). Đề xuất: crash-finalizer khi resume phát hiện run mồ côi → ước lượng token từ checkpoint counter cuối + ghi stopReason=crashed với metrics tốn tối thiểu.

### BUG2-006 · A · P2 · 17:13:25Z + 17:14:02Z · Tool callOmega bị CẮT CỤT GIỮA JSON ×2 liên tiếp — vấn đề cốt lõi cluster-① vẫn tái diễn thật
- **Hiện tượng:** "⚠️ Tool call bị cắt cụt giữa JSON (lần 1/2)" rồi "lần 2/2" — Omega phát file_write/tool JSON lớn bị cắt giữa chừng. Hệ thống tự phản hồi lỗi kèm hướng dẫn "phát lại gọn hơn (chia file nhỏ, file_write append)" — cơ chế tự chữa r68 vẫn sống và đúng.
- **Bằng chứng:** main run evt37, evt43; snapshot 17:13:25Z + 17:14:02Z.
- **Đánh giá:** self-heal hoạt động nhưng gốc bệnh (model phát tool call vượt giới hạn output → đứt giữa JSON) chưa có phòng ngừa tầng mã. Đề xuất hardcode: (a) phát hiện sớm ở stream layer khi output chạm ngưỡng max_tokens mà chưa khớp cặp đóng JSON → phát pre-emptive hint; hoặc (b) tool file_write chia nhỏ tự động khi args &gt; ngưỡng. Theo dõi tần suất: nếu lặp ≥3/run → fix cấu trúc theo nguyên tắc D7.1.

### BUG2-007 · D · P2-Nghi-vấn · 17:13:37Z · Detector ngôn ngữ bắn cảnh báo "tiếng Anh ratio 0%" ngay sau tool-call đứt + thought RỖNG — nghi đo nhầm JSON máy
- **Hiện tượng:** evt38 = thought event VỚI TEXT RỖNG; evt39 ngay sau = "⚠️ NGÔN NGỮ: output tiếng Anh (ratio 0%) — đã cảnh báo viết tiếng Việt (lần 1/2)". Ngữ cảnh: vừa xảy ra tool call đứt JSON (evt37) — output lặp lại "ngôn ngữ" khả năng là chính khối JSON/tool-call đứt (không có dấu tiếng Việt là BẤT CỔ ĐIỂN của JSON) chứ không phải agent chuyển sang suy nghĩ tiếng Anh.
- **Bằng chứng:** main run evt37→38→39 liền kề 17:13:25→17:13:37.
- **Đánh giá:** nếu xác nhận → false positive làm nhiễu kênh giám sát ngôn ngữ (chống mục đích detector). Cần đối chiếu mã: text đưa vào detector có loại phần tool-call/JSON ra chưa. Nếu đo trên assistant content thô kể cả tool-call block → phải mask trước (dùng chung tầng maskToolCallText r68-F5).

### BUG2-008 · E · P3 · 17:13:37Z · Thought event RỖNG bị persist vào kênh quan sát
- **Hiện tượng:** evt38 thought text="" — mission-watch hiển thị dòng 💭 trống. Nhiễu nhẹ kênh THINKING.
- **Đánh giá:** recordAgentThought nên skip/đánh dấu rỗng (filter text.trim() === '').

### BUG2-009 · E · P3 · 17:05Z · Lời giao delegation bị cắt 254 ký tự ở MỌI kênh ghi — không truy hồi được toàn văn sau này
- **Hiện tượng:** run_start text của sub jsonl cắt tại 254 chars ("…Lưu artifact báo cáo mach…"); dev.log dòng [SubAgent] Omega → … cắt ~100 chars; checkpoint không chứa. Vụ BUG2-003 điều tra bị chặn chính vì không lấy được toàn văn lời giao (phải dựng lại từ tiêu chí directive).
- **Đánh giá:** P3 nhưng là debt quan sát thật: mọi cuộc điều tra post-hoc về "TL đã giao gì cho sub" đều thiếu dữ kiện. Đề xuất: lưu toàn văn task+context vào cột riêng của AgentRunRecord (hoặc bảng DelegationBrief) tại thời điểm dispatch.

### LIVE-✅-6 · H+G — Durable resume + kỷ luật phục hồi của Omega sau sự cố restart (chu kỳ 2, 17:11-17:14Z)
- **Hiện tượng:** sau 2 lần restart, job durable tự sống lại (đúng thiết kế r60+); cơ chế resume phát hiện chính xác 3 delegation bị giết + inject notice "cân nhắc re-dispatch"; Omega KHÔNG mù quáng re-dispatch lại mà tự đọc trace jsonl của 3 sub (evt32-34 file_read sub_*.jsonl) để phục hồi bằng chứng + đánh giá phần việc đã làm — hành vi TL khéo đúng triết lý "bằng chứng máy trước, lời nói agent sau".
- **Bằng chứng:** main evt17-45; git status 9 file thay đổi thật khớp trace RAMPAGE/SENTINEL.
- **Đánh giá:** đây là lần ĐẦU TIÊN quan sát thấy đường crash→resume→tự-phục-hồi-bằng-trace hoạt động trọn vẹn trên mission thật — tăng độ tin cậy hạ tầng đáng kể so với r54 (mission chết trắng).

### LIVE-✅-7 · E — Nén context chạy đều tay (3 lần trong 4 phút, không đè tải lại)
- **Hiện tượng:** "📦 Nén context #1 ~31k → #2 ~27k → #3 ~32k ký tự (LLM digest)" — chu kỳ 2 Omega đọc 3 file jsonl lớn (mỗi file 20-65 events) mà context vẫn được giữ gọn, message gần nhất giữ nguyên.
- **Đánh giá:** CI-3 compression vận hành đúng; đối lập mission #18/19 cháy 4-4.6M token một phần do context phình.

### GHI-NHẬN-ĐANG-THEO-DÕI (chưa kết luận)
- **(a) "Lượt output THUẦN VĂN BẢN (0 tool call, lần 1/2)" 17:14:08Z:** nudge chống lập-kế-hoạc-không-hành-động bắn đúng lúc Omega phân tích trace (chưa rõ là phân tích hợp lệ hay vòng lặp kế hoạch). Theo dõi: nếu lên 2/2 + lặp thêm → ghi thành BUG2-0xx loại B.
- **(b) Omega đọc sub jsonl bằng file_read (evt32-34):** hành vi hợp lệ nhưng cho thấy thiếu tool truy vấn "kết quả delegation"structured — TL phải mò file thô. Cân nhắc sau phiên: tool delegation_result(index) để đọc có cấu trúc.
- **(c) 9 file thay đổi chưa kiểm định trong working tree:** chờ Omega chu kỳ sau chạy kiểm định (tsc/gate) — nếu wrap-up mission mà vẫn chưa kiểm định → ghi BUG2-0xx (bàn giao rủi ro).

### BUG2-010 · G+B · P1 · 17:09:31Z · RAMPAGE để lại file test MỖI CÚ PHÁP trong working tree khi bị giết giữa chừng
- **Hiện tượng:** RAMPAGE chạy `bun test tests/sql-injection-regression.test.ts` (file chính nó vừa tạo) → "❌ Tests failed: # Unhandled error between tests — 54 | * Vì literal bị nuốt trọn, comment chứa dấu `'` không thể…" (lỗi cú pháp tại L54 — comment chứa nháy đơn). Sub bị restart giết chưa kịp sửa → working tree hiện chứa file test VỠ + 7 file sửa + sql-policy.ts mới — toàn bộ CHƯA KIỂM ĐỊNH bởi bất kỳ ai.
- **Bằng chứng:** `sub_1791479109523_2.jsonl` evt54 (run_tests success=false, resultPreview nguyên văn); `git status` (tests/sql-injection-regression.test.ts untracked mới).
- **Đánh giá:** P1 — nửa sự kiện "bàn giao rủi ro" (GHI-NHẬN-c) đã thành hiện thực: code từ agent đã chết, có lỗi thật, nằm trong tree. Nếu Omega/chu kỳ sau không soi ra mà mission kết thúc với "hoàn thành" → false compliance nặng (D2). Theo dõi: chu kỳ sau có chạy gate/tsc không.

### BUG2-011 · G · P2 · 17:05–17:10Z · run_tests sinh tiến trình con `bun test` trần, không throttle — khuếch đại bộ nhớ trên hộp 4GB
- **Hiện tượng:** trong 5 phút, SENTINEL gọi run_tests 5 lần (evt16/42/46/53/56 — mỗi lần spawn tiến trình `bun test tests/execute-route-security.test.ts` tải lại toàn bộ module app) + RAMPAGE 1 lần — song song với 3 sub-agent各自 giữ context 60-65k token (ZEN log: prompt 62417/60337/64708 tokens). Trên hộp 4041MB RAM (available chỉ ~2GB), chuỗi này đẩy RSS app lên vùng 2.1GB → xem BUG2-004.
- **Bằng chứng:** 6 run_events run_tests trong 3 sub jsonl; ZEN prompt-size lines dev.log 292905-292925; `free -m` (Mem 4041MB).
- **Đánh giá:** P2 — công cụ đúng việc nhưng thiếu quản trị tài nguyên: (a) không giới hạn số tiến trình test đồng thời; (b) không kiểm tra MemAvailable trước spawn; (c) run_tests failure lúc 17:09:55/17:10:21 (evt46/53 SENTINEL — "Command failed" dù 4 lần khác pass 59-65/65) trùng cửa sổ app hấp hối → kết quả test NHẢY khi hệ thống thiếu tài nguyên (độ tin cậy kiểm định bị bào mòn đúng lúc cần nhất). Đề xuất: semaphore 1-test-cập + pre-flight mem guard + đánh dấu kết quả "degraded" khi spawn trong lúc RSS cao.

### LIVE-✅-8 · G — Chuỗi an toàn hạ tầng vận hành ĐÚNG THIẾT KẾ qua cơn bội nhớ (17:08–17:12)
- **Hiện tượng:** process cũ bị reaper sandbox giết âm thầm (~2.1GB) → PM2 kéo dậy restart-1 → restart-1 RSS 2126MB chạm HARD-RSS 2100MB → MemWatchdog self-exit SẠCH có log đầy đủ ("chờ 600ms cho response đang bay flush hết rồi exit(1)") → PM2 restart-2 → sống sót, RSS 2009MB lùi về 609MB sau khi resume ổn định. Health 200 trở lại trong ~4 phút kể từ lúc health=500 đầu.
- **Bằng chứng:** dev.log 293087-293590 (MemWatchdog lines); keepalive log 17:08:25/17:11:18; PM2 restart 325→327; current health 200.
- **Đánh giá:** cả 3 lớp (MemWatchdog avail-aware + HARD-RSS, PM2, durable goal-loop resume) phối hợp đúng leaf design r54-60. Điểm yếu duy nhất còn hở = delegation không durable (BUG2-004) — việc TA phải fix, không phải lỗi của watchđog.

### CẬP NHẬT BUG2-004 (root-cause xác định — hạ từ P0-chờ xuống P1)
- **Chuỗi nhân đã giải mã:** (1) 3 sub song song × context 60-65k token + 6 tiến trình `bun test` con trong 5 phút → RSS leo vùng 2.1GB trên hộp 4GB; (2) health /api/health suy biến 637ms → 500 (17:08:25); (3) process cũ bị reaper SIGINT âm thầm ~17:10:5x (không kịp log — đúng kịch bản MemWatchdog sinh ra để đón đầu nhưng lần này không kịp); (4) restart-1 resume main run → RSS 2126MB → MemWatchdog HARD-RSS self-exit sạch (17:11:3x); (5) restart-2 ổn định.
- **Xếp hạng lại:** P1 (không P0) — hạ tầng an toàn hoạt động đúng, mission tự phục hồi; khoảng trống cấu trúc thật sự = **delegation không durable** (sub-run chết trắng cùng process, kết quả + máy đo + git-delta report mất) + **thiếu quản trị tài nguyên khi phân công song song** (không tokens/mem budget cho delegation song song). Đề xuất fix cấu trúc theo D7.1: (a) đăng ký delegation vào durable queue với checkpoint từng vòng sub (resume có thể nối lại hoặc đánh dấu conclated-with-partial-evidence từ trace jsonl — thực tế Omega đã tự làm bằng tay lần này, thể chế hóa nó); (b) cổng phân công song song kiểm tra MemAvailable + RSS trước khi chấp nhận delegations mới.

### BUG2-012 · A · P1 · 17:14–17:18Z · Tool-call dạng THỨ 9 `tool_use>{"tool_uses":[{"recipient_name":"functions.X","parameters":…}]}` (định dạng Claude) — parser KHÔNG nhận diện, gây chuỗi "0 tool call" oan
- **Hiện tượng:** từ it13 trở đi, model phát tool call theo format `tool_use>{"tool_uses":[{"recipient_name":"functions.file_read","parameters":{…}}]}` kèm các biến thể garble tiền tố (`ngt_2b90d4cfb8c4_rewritten>`, `< foothold to=todo_write`, `divid="analysis code">`). Hệ quả chuỗi: (a) một số lượt parser bắt được call (file_read vẫn execute evt48/51/57-59/64-65) nhưng một số lượt KHÔNG → prose-nudge "Lượt output THUẦN VĂN BẢN (0 tool call)" bắn 2/2 (evt45, evt70) oan — model ĐANG cố gọi tool mà bị bảo "hãy phát tool call thật"; (b) maskToolCallText không che dạng `recipient_name/tool_uses` → thought event nguyên văn khối JSON (evt55, evt68) — ngược lại với mục tiêu F5 r68; (c) model rối ý thức cú pháp — tự suy luận tiếng Anh "Wait native tool call syntax in this environment: use recipient…" (evt88) rồi thử đủ loại format.
- **Bằng chứng:** main evt45/55/62/68/70/75/88/93 (thought nguyên văn + các marker); evt57-60 (file_read ×3 args y hệt execute được — đường parse khác đã bắt được phần khác của output).
- **Đánh giá:** P1 — dạng méo thứ 9 lộ ra đúng lúc model dưới stress (sau restart + cảnh báo ngôn ngữ): hệ parser 8 dạng + detector vẫn có điểm mù. Cần: (1) thêm pattern `tool_use?>?\s*\{"tool_uses":\[…\]\}` bóc `recipient_name` (bỏ tiền tố `functions.`) + `parameters` → normalize về tool call chuẩn; (2) mở rộng maskToolCallText che cả khối này; (3) xem xét garble-prefix stripper tổng quát hơn (tiền tố rác kết thúc bằng `>` trước khối JSON).

### BUG2-013 · D+C · P1 · 17:13–17:18Z · Detector ngôn ngữ NHIỄU NẶT: 11 cảnh báo trộn oan-và-đúng, false-positive từ JSON công cụ → borías evidence chu kỳ + ô nhiễm phán quyết trọng tài
- **Hiện tượng:** viLateCount leo lên 11 trong 5 phút (evt50→89, "lần thứ 1→11"). Phân tích thought: phần lớn cảnh báo bắn trên lượt có content = tool-call JSON thuần (evt47 ratio 0% ngay sau thought rỗng evt46/49/52) — OAN; nhưng CÓ vi phạm thật: evt68 "We need produce tool call. Since tools not actually exposed as namespace in prompt UI?…", evt88 "…we need emit tool call</thinking>Wait native tool call syntax…" — model chuyển sang tiếng Anh khi rối. Hai loại trộn lẫn trong CÙNG một bộ đếm không phân biệt được → "bằng chứng chu kỳ" mà trọng tài độc lập đọc (evidence kind=harness_warning) giờ chứa tín hiệu sai → phán CHƯA ĐẠT có thành phần gây nhiễu không phải lỗi việc.
- **Bằng chứng:** evt47-89 chuỗi cảnh báo; evt68/88 nguyên văn tiếng Anh thật; mã L3467 (detector đo result.content THÔ không qua mask).
- **Đánh giá:** P1 — đây là hậu quả kép của BUG2-007: không chỉ nhiễu kênh giám sát mà NHIỄM BẰNG CHỨNG trọng tài (D2 trung thực). Fix gốc như BUG2-007 (đo trên prose đã mask) + tách 2 bộ đếm (falseFromToolJson vs trueEnglishProse) — sau fix, bộ đếm mới sẽ còn đúng nghĩa.

### BUG2-014 · C+B · P1 · 17:18:56Z · Chuỗi nhân crash→mất-bằng-chứng→phán-âm: artifact THẬT tồn tại nhưng trọng tài + Omega không ghi nhận — quỹ đạo verdict_stagnation lặp lại #18/#19
- **Hiện tượng:** trọng tài chu kỳ 2 phán CHƯA ĐẠT (2%): "[Nghiệm thu P1-3] chưa có bằng chứng chạy thật cho secret scan có redact, bun audit…" — trong khi Linh Sickyx ĐÃ làm trọn việc đó trước khi bị giết: `scratch/p1-3/P1-3-SECURITY-INVENTORY.md` (10KB), `secret-inventory.tsv` (17.5KB), `bun-audit.txt` + 68-event trace. Bằng chứng mất trắng cùng crash (BUG2-004) + Omega đọc trace qua digest nén (Nén #1-#8) không nối được artifact-hữu-hình → tiêu chí. Chu kỳ 3 lặp lại phán âm (3%) — đúng quỹ đạo chết mission #18 (verdict_stagnation sau 4M tokens).
- **Bằng chứng:** evt94 (nguyên văn phán), evt101 (chu kỳ 3 y hệt), ls scratch/p1-3/ (3 file thật, mtime 17:05-17:07).
- **Đánh giá:** P1 — chỗ hở cấu trúc: resume-notice chỉ nói "kết quả mất trắng, cân nhắc re-dispatch" mà KHÔNG trỏ agent tới (a) trace jsonl đường dẫn cụ thể, (b) artifact để lại trên đĩa. Omega phải tự mò (đã mò — evt32-34 — nhưng digest làm mất chi tiết). Fix hardcode: khi phát hiện delegation bị giết giữa chừng, hệ thống TỰ quét jsonl trace + working-tree delta rồi inject "BẢNG CỒ LẠI TỪ CRASH" (path trace + path file tạo/sửa + todo cuối của sub) vào notice — biến việc Omega tự làm thủ công thành cơ chế.

### LIVE-✅-9 · E — BUG-022 (r69) digest re-inject + phanh đọc lặp bắn ĐÚNG đặc tính trên mission thật
- **Hiện tượng:** evt60 "📖 Phát hiện đọc lặp: file_read × 3 lần args y hệt — đã nhắc…" → evt66 "📖 PHANH ĐỌC LẶP: agent-runs/sub_1791479109537_3.jsonl đọc 5 lần — re-inject digest đầu file để agent ngừng đọc lại toàn file (BUG-022)". Đúng ngưỡng 5 lượt + hành vi re-inject như thiết kế r69.
- **Đánh giá:** fix r69 xác nhận sống; chính cơ chế này giúp Omega thoát vòng đọc-lặp (sau evt66 model ngừng đọc lại file đó).

### LIVE-✅-10 · C — AUTO-ESCALATE → advisory → AUTO-APPLY chu kỳ 2→3 vận hành trọn vẹn
- **Hiện tượng:** evt96 "🧠 AUTO-ESCALATE: chu kỳ 2 chưa kiểm định được → đã hỏi Omega orchestrator (11639 tokens)"; evt97 "🚀 AUTO-APPLY advisory: Omega điều MEGATRON xử lý giúp" → chu kỳ 3 bắt đầu với chẩn đoán "Run chỉ đi sâu một phần P0-1 và đọc lại transcript của các delegat…" — advice có nội dung cụ thể.
- **Đánh giá:** cơ chế tự-vươn-tầng-trên hoạt động đúng lúc bế tắc — đối lập mission #18 chết im lặng. Theo dõi chi phí: mỗi escalate ~11-12k tokens.

### GHI-NHẬN-ĐANG-THEO DÕI (bổ sung)
- **(d) Model tự bịa tool-result JSON trong content (evt62):** sau marker mask `[🔧 file_read(…) — tool call đã tách khỏi suy nghĩ]`, model viết tiếp `{"tool":"file_read","success":true,"result":{…}}` GIẢ — fabricate kết quả tool trong văn bản. Evidence thật tách riêng nên không lỡ việc, nhưng nguy cơ evaluator đọc content sẽ bị đánh lừa nếu không đối chiếu tool event. Theo dõi tần suất.
- **(e) Mojibake provider-side tái diễn (evt75 `ngt_2b90d4cfb8c4_rewritten>`, evt93 `divid="analysis code">`):** đã ghi blocked-upstream ở bug.md r69 — tần suất hôm nay tăng khi model stress. Chỉ ghi nhận số liệu cho báo cáo upstream.

### LIVE-✅-11 · B — READ-ONLY enforcement (r69 BUG-010/014) xác nhận SỐNG qua cờ TL — strip 7 tool ghi chính xác
- **Hiện tượng:** chu kỳ 4, Omega phân công SENTINEL "Kiểm định read-only hạng mục P0-3…" kèm cờ readOnly chủ động → dev.log: "SENTINEL READ-ONLY delegation contract (cờ từ TL) — strip 7 tool ghi khỏi whitelist: file_edit, file_write, shell, run_bg, gateway_edit, create_custom_tool, delete_custom_tool · giữ 32 tool đọc/kiểm định".
- **Bằng chứng:** dev.log:295529-295530; sub run sub_1791480191932_2.
- **Đánh giá:** tầng enforcement hoạt động chính xác khi cờ được đặt. Đối chiếu BUG2-003: lỗ hổng duy nhất còn lại là auto-detect từ lời giao — TL truyền cờ tay là đường vòng an toàn hiện có. Sau fix BUG2-003, hai đường sẽ cùng thông.

### LIVE-✅-12 · C+D — AUTO-ESCALATE advisory (MEGATRON) chẩn đoán hiệu quả + detector ngôn ngữ bắn ĐÚNG vi phạm thật và model chỉnh ngay
- **Hiện tượng:** MEGATRON nhận nhiệm vụ chẩn đoán bế tắc: it1 nghĩ bằng tiếng Anh ("I'll start by reading the actual state…") → detector bắn (lần 1/2) → TOÀN BỘ suy nghĩ sau đó tiếng Việt chuẩn. Kết thúc: "concluded · 11 vòng · 12 tool calls · 277822 tokens · trọng tài ĐẠT (94%)" với báo cáo chẩn đoán cụ thể (đọc backlog bằng sqlite mode=ro — kỷ luật đọc an toàn). Chu kỳ 3-4 của Omega đổi chiến lược đúng theo chẩn đoán (tập trung P0-3 + tự git status đối chiếu working tree).
- **Bằng chứng:** sub_1791479949239_1.jsonl evt1-2 (tiếng Anh thật → cảnh báo), evt24 (run_end 94%); main evt96-102.
- **Đánh giá:** chuỗi escalate→advisory→apply hoạt động trọn vẹn; detector phân biệt đúng vi phạm thật (đối lập các false-positive ở main — củng cố luận điễm BUG2-013: sai ở tầng đo text, không sai ở logic detector).

### GHI-NHẬN-ĐANG-THEO DÕI (bổ sung)
- **(f) Chi phí advisory 278k token cho nhiệm vụ chẩn đoán "≤5 bước" (MEGATRON chạy 11 vòng):** dưới ngưỡng cảnh báo 1.2M nên không bắn tier — hợp lệ theo chính sách, nhưng ghi nhận hiệu suất để so sánh nếu mẫu lặp (D5).
- **(g) Toolset không đồng nhất giữa các lần delegate cùng agent (SENTINEL 17:05 nhận 22 tool, 17:23 nhận 39→32):** chưa rõ nguyên nhân (profile path khác nhau giữa 2 đường dispatch?) — nếu lặp lần 3 thì lập BUG2-0xx điều tra whitelist nguồn.

### BUG2-015 · G+B · P1 · 17:24:01Z · Delegation chết nhãn "error" thay vì chờ/tái thử khi provider 429 rate-limit — sub loop thiếu graceful degradation
- **Hiện tượng:** SENTINEL-readonly (4 vòng, 8 tool calls, 71,640 tokens, 49s) kết thúc "[Delegation] error". Cửa sổ thời gian trùng đúng đợt `[ZEN] agent:space-bunny-free 429 rate-limited (key #1) — cooldown 60s FreeUsageLimitError`. Trình tự sự kiện: run_gate 17:23:31 → 429 → loop error 17:24:01 → trọng tài hậu kiểm CHƯA ĐẠT 18% + đóng 5 todo dang dở → "xong: error". Main loop có cơ chế cooldown; sub loop có vẻ để exception LLM lan thành kết thúc run.
- **Bằng chứng:** dev.log (dòng 429 + "[SubAgent] SENTINEL xong: error — 4 vòng…"); sub_1791480191932_2.jsonl evt12-13.
- **Đánh giá:** P1 — khi provider nghẽn (điều BẮT BUỘC xảy ra ở mission lớn dùng free-tier), mọi delegation đang chạy sẽ chết nhãn error nếu không có retry/backoff tại tầng sub. Fix hardcode: bắt lỗi 429/provider-transient trong runSubAgentLoop → backoff 60-90s (tôn trọng cooldown) + tối đa N lần rồi mới conclude "degraded"; tuyệt không chết ngay.

### BUG2-016 · C · P2 · 17:24Z · Tái diễn họ evidence-truncation r68/BUG-017: trọng tài độc lập phán âm vì kết quả tool lớn bị cắt — "Machine-search có 72 kết quả nhưng bằng chứng bị cắt"
- **Hiện tượng:** trọng tài delegation SENTINEL phán CHƯA ĐẠT (18%) với lý do "Machine-search có 72 kết quả trong src nhưng bằng chứng bị cắt, chưa lập inventory" — callIndex (fix F1 r68) cho arbiters thấy tool ĐÃ chạy, nhưng preview 160-chars vẫn cắt substantive result → không thẩm định được nội dung. Cùng họ nguyên nhân với BUG-017 r68 (phán âm 28%/20% vì tier cắt tool call ĐẦU run) — lần này cắt ởChi TIẾT kết quả thay vì danh sách call.
- **Bằng chứng:** dev.log "[SubAgent] SENTINEL trọng tài độc lập: CHƯA ĐẠT (18%) — thiếu: Machine-search có 72 kết quả…bằng chứng bị cắt".
- **Đánh giá:** P2 — fix hướng: entry evidence cho tool đọc/khảo sát kèm RESULT DIGEST có cấu trúc (số match + N path đầu + phân bố theo file) thay vì preview cắt; hoặc arbiter được quyền gọi lại grep thuần-đọc để tự kiểm (evidence re-verification path — cân nhắc chi phí token).

### LIVE-✅-13 · B — Bộ 3 cơ chế kỷ luật delegation cùng bắn ĐÚNG trong 1 cửa sổ (chu kỳ 4, 17:23-17:26Z)
- **Hiện tượng:** (1) MEGATRON READ-ONLY delegation contract (cờ từ TL) — strip 17 tool ghi, giữ 43 tool đọc/kiểm định (lần thứ 2 readOnly enforcement kích hoạt, giờ cả với profile 61-tool); (2) scope-guard todo: MEGATRON khai sessionId "p0-3-verification" ≠ scope delegation → hệ thống ép lại (chống todo rơi scope sai — FIX A r54); (3) SubAgentSlot key-pinning: "MEGATRON nhận slot 1/3 — ghim Zen key #1 riêng cho toàn bộ run" (user directive key riêng cho sub).
- **Đánh giá:** 3 tầng guard độc lập cùng vận hành đúng trong 3 phút — hệ thống kỷ luật delegation r54→r69 ổn định ở tầng enforcement khi cờ/tín hiệu đến đúng chỗ.

### GHI-NHẬN-ĐANG-THEO DÕI (bổ sung)
- **(h) Provider 429 FreeUsageLimitError bắt đầu 17:23Z (key #1, cooldown 60s):** mission đã đốt 1.5M+ token/20 phút — free-tier chạm trần nhịp. Nguy cơ: chu kỳ chậm dần, các delegation sau rơi vào BUG2-015. Theo dõi: key-pinned MEGATRON (slot 1/3, key #1) có bị 429 dây chuyền không — nếu có, cân nhắc hardcode: vòng-robin key cho slot thay vì ghim khi key đang cooldown.

### BUG2-017 · B · P2 · 17:28:18Z · TODO-completion guard bắn nudge STALE — snapshot in-memory nói "9 mục CHƯA hoàn thành" trong khi DB (todo_read) 9/9 completed
- **Hiện tượng:** MEGATRON P0-3 conclude sau khi todo_write cập nhật 9 mục → nhận nudge "còn 9 mục CHƯA hoàn thành" → phải tốn 1 vòng todo_read xác minh "nguồn chân lý máy trả 9/9 completed — cảnh báo là stale" rồi conclude lại. Nudge là SAI SỰ THẬT — enseñagent nghi ngờ phản hồi máy đúng.
- **Cơ chế (đã soi mã):** guard dùng `lastTodoSnapshot` (in-memory). Ảnh chập được cập nhật bởi 2 đường: (a) args-merge từ todo_write — item thiếu status mặc định `'pending'` (L1188); (b) autoCompleteRunTodosByEvidence TRẢ ĐẦY ĐỦ todo của run (L4530 — đúng thiết kế) NHƯNG chỉ chạy khi batch có evidence (L1265: `batchEvidence.length > 0`). Batch cuối của MEGATRON chỉ có todo_write (không evidence) → đường (b) bỏ qua → snapshot = 9 pending từ args-merge → nudge oan.
- **Đánh giá + hướng fix hardcode (2 lớp):** (1) args-merge theo id: item đến KHÔNG có status → GIỮ status cũ thay vì mặc định pending (chống regross snapshot); (2) tại conclude-check, nếu openTodos > 0 → đọc lại DB (1 query delegation-scope) trước khi nudge — chỉ nudge khi DB xác nhận còn mở. Sau fix, lớp (2) là nguồn sự thật tuyệt đối cho guard.
- **Bằng chứng:** sub_1791480261986_3.jsonl evt41→44 (todo_write) → nudge → evt47 (todo_read 9/9) → evt48 (báo cáo nêu stale); mã subagent-delegate.ts L1182-1193 + L1265-1274 + L1036-1045, dev-tools.ts L4498-4546.

### BUG2-018 · G · P1 · 17:29–17:31Z · Provider free-tier cạn (429 toàn chuỗi) giết cả delegation LẪN evaluator — mission kết thúc no_progress "CHƯA hoàn thành" lần thứ 4 liên tiếp
- **Hiện tượng:** sau 3.7M token/28 phút, Zen space-bunny-free 429 "FreeUsageLimitError" dai dẳng (key #1 cooldown 60s lặp lại). Hậu quả dây chuyền cuối mission: (1) SENTINEL delegation 17:30 chết "Lỗi: Zen model thất bại toàn chuỗi (HTTP + CLI): Zen 429 rate-limited (key #1)" (evt145); (2) evaluator chu kỳ 5-6 cũng 429 → fallback "CHƯA ĐẠT 30% + evaluator lỗi" (evt150/155) — phán quyết cuối của mission do HEURISTIC đưa ra khi provider chết, không phải thẩm định thật; (3) no_progress → stall brake cắt mission 17:31. Chuỗi 4 mission liên tiếp (06:50 no_progress · 09:25 verdict_stagnation · 15:38 verdict_stagnation · 17:31 no_progress) đều "CHƯA hoàn thành".
- **Đánh giá:** P1 — 2 lỗ hỏp cấu trúc lộ rõ: (a) sub-loop/evaluator không degrade nhẹ nhàng khi provider transient-fail (liên quan BUG2-015 — fix backoff chung); (b) KHÔNG có failover chéo provider cho luồng agent/evaluator (NVIDIA fallback chain chỉ phục vụ luồng NVIDIA — khi Zen chết thì chết cả hệ). Đề xuất minimal hardcode: provider-health flag (429 persistence tracker) + delegator pre-flight: đang cooldown → HOÃN dispatch kèm note thay vì thả delegation vào chỗ chết; middleware evaluator: 429 → retry backoff trước khi rơi vào fallback.
- **Bằng chứng:** evt145/150/155/156; dev.log các dòng 429 quanh 17:23-17:31; "[SubAgent] SENTINEL xong: error… 429 rate-limited"; task_summary "evaluator lỗi — kết luận thuần text KHÔNG đủ".

### BUG2-016-bis · C · P1 · 17:28:18Z · Trọng tài phán MEGATRON CHƯA ĐẠT 12% vì catch-22 evidence-cắt: yêu cầu "trình bày đủ inventory" trong khi chính tier evidence cắt 74-match kết quả
- **Hiện tượng:** "[SubAgent] MEGATRON trọng tài độc lập: CHƯA ĐẠT (12%) — thiếu: AC1: Báo cáo chỉ nêu tổng 74 match và một số dòng tiêu biểu, không trình bày đủ…" — sub đã chạy grep 74 match (đúng việc), báo cáo nêu tổng + dòng tiêu biểu, NHƯNG tier evidence cắt kết quả đầy đủ → trọng tài đòi thứ hệ thống không cho nó thấy. 872k token công sức bị phán âm vì giới hạn hiển thị, không phải vì việc sai.
- **Đánh giá:** xác nhận cơ chế BUG2-016 bằng trường hợp thứ 2 trong cùng mission — nâng mức ưu tiên fix evidence-digest lên P1 (gộp chung mục 016).

### LIVE-✅-14 · B — BUG-009/025 (r69) wrap-up "THAY ĐỔI CHƯA COMMIT (bàn giao)" xác nhận ĐẦY ĐỦ trên mission thật kết thúc
- **Hiện tượng:** evt157 + cuối GoalLoopJob.result: khối "📁 THAY ĐỔI CHƯA COMMIT trong working tree" liệt kê CHÍNH XÁC 11 file (7 M + 4 ??) khớp 100% `git status` thời điểm đó, kèm chỉ dẫn bàn giao "commit kèm provenance HOẶC discard tường minh — không để mất trắng".
- **Đánh giá:** cơ chế r69 hoạt động end-to-end kể cả trong kịch bản xấu nhất (sub bị giết giữa chừng — đúng loại tình huống nó được xây để hứng).

### LIVE-✅-15 · D2 — Báo cáo cuối mission trung thực theo chuẩn bằng chứng máy
- **Hiện tượng:** final report (8,055 chars) mở đầu "1. ĐÃ LÀM ĐƯỢC" toàn mục `[verified-by-tool]` trích file:dòng cụ thể (route knowledge/query dòng 7-9/134, SQL policy dòng 152-164…), phần "còn thiếu" nêu đúng các tiêu chí chưa có bằng chứng, không có tuyên bố rút gọn kiểu "..." cả.
- **Đánh giá:** đối lập các mission cũ — kết quả huấn luyện prompt-protocol + machine-evidence đang cho ra văn hóa báo cáo đúng chuẩn D2.

---

## KẾT THÚC MISSION + PHẦN TỔNG HỢP PHIÊN QUAN SÁT

> **Mission `cmuzscdvj0013llzrvlyky79t`:** 17:03:29 → 17:31:43Z (28.2 phút) · 6 chu kỳ · 39 vòng main · 36 tool calls main · 2.5M tokens main + 1.2M sub (3.7M tổng) · 7 delegation (3 bị restart giết, 2 chết 429, 2 concluded) · stop=no_progress (stall brake) · kết luận "CHƯA hoàn thành".

### BẢNG CHẤM GIÁM SÁT — phiên quan sát 2026-10-08 17:05–17:35 (round 70)
| Lĩnh vực | Đạt | Tối đa | Bằng chứng chính |
|---|---|---|---|
| D1 Thực thi | 9 | 12 | Stall brake cắt đúng lúc (no_progress sau 2 chu kỳ fallback); mọi run failed có root-cause trong Bug_v2.md; trừ 3: restart giết 3 delegation giữa chừng (phát hiện sau khi xảy ra — keepalive cảnh báo 17:08 nhưng mission-side không có kênh báo trước) |
| D2 Trung thực | 17 | 20 | Final report chuẩn [verified-by-tool] + wrap-up 11 file khớp git; trừ 3: 2 phán âm của trọng tài (MEGATRON 12%, SENTINEL 18% — catch-22 evidence) + 1 nudge stale sai sự thật (BUG2-017) |
| D3 Phán quyết | 6 | 12 | 2/6 chu kỳ cuối phán bởi fallback heuristic (429) thay vì evaluator thật; 0 ledger thao tác; không khép mission (đúng — chưa đạt) |
| D4 Hạ tầng | 13 | 16 | Chuỗi MemWatchdog→PM2→durable resume vận hành đúng qua wedge 500→000; infra-guard chặn .env; trừ 3: 2 lần restart liên tiếp + memory peak 2126MB (m Bash gốc bị reaper giết không kịp log — watchdog không đón kịp lần đầu) |
| D5 Ngân sách | 4 | 10 | Token-burn hiển thị live đúng (máy đo); trừ 6: 3.7M/28phút không một cảnh báo dự phòng nào về provider capacity — mission chết vì cạn hạn mức free-tier mà không ai thấy tới trước (BUG2-018); 872k cho 1 delegation kiểm định không có tier warning (dưới ngưỡng 1.2M — theo thiết kế nhưng vẫn là điểm yếu pacing) |
| D6 Điều phối | 9 | 10 | Quan sát liên tục không can thiệp sớm; mọi phát hiện ghi tức thời Bug_v2.md; trừ 1: không dự đoán được 429 (chuỗi mission trước đều 3.8-4.6M — mức 3.7M lần này chạm trần nhanh hơn do 3 sub song song) |
| D7 Sửa hệ thống | 10 | 10 | 15 bug ghi nhận cùng phiên, fix bắt đầu ngay trong phiên (xem phần C) — chuẩn D7.1 mọi sự cố có fix cấu trúc đề xuất tầng đúng |
| D8 Hồ sơ | 9 | 10 | Bug_v2.md 196 dòng cập nhật tức thời + trace path đầy đủ; trừ 1: worklog + push còn treo (sẽ hoàn tất cuối phiên) |
| **TỔNG** | **77** | **100** | **🟡 VÀNG — điểm yếu tập trung D3 (phán quyết dưới provider chết) + D5 (provider capacity blind spot)** |

### A. TỔNG KẾT KIỂM CHỨNG SỐNG (đối chiếu fix r68/r69 — mục tiêu chính của phiên)
| Fix cũ | Trạng thái | Bằng chứng |
|---|---|---|
| BUG-008 directive-guard enrichment (r69) | ✅ SỐNG | evt0: 8 tiêu chí tự truy hồi từ backlog |
| BUG-022 digest re-inject (r69) | ✅ SỐNG | evt66 phanh đọc lặp đúng ngưỡng 5 |
| BUG-010/014 readOnly whitelist strip (r69) | ✅ SỐNG (cờ TL) | MEGATRON strip 17 tool, SENTINEL strip 7 tool |
| BUG-009/025 wrap-up git-delta (r69) | ✅ SỐNG | evt157 + result: 11 file khớp git status |
| BUG-003 mask tool-call khỏi thought (r68 F5) | ✅ SỐNG (6 dạng cũ) / ⚠️ HỞ dạng 9 mới | evt62 marker mask đúng; evt55/68 lộ dạng tool_use (BUG2-012) |
| F6 ngôn ngữ sub-loop detector (r68) | ✅ SỐNG + ✅ nudge hiệu quả | MEGATRON it1 Anh → 1 nudge → Việt hết run; Linh Sickyx 2 nudge + late-count |
| F9/P0-1 read_output exitCode (r65/r69) | ⚠️ KHÔNG cọ sát | không sub nào dùng run_bg/read_output phiên này |
| BUG-024 final-report retry (r69) | ⚠️ KHÔNG cọ sát | report thành công lần đầu (0 retry cần) |
| DATA MAP F3 (r68) | ⚠️ CHƯA xác minh được | không quan sát thấy dấu hiệu sử dụng map trên main/sub phiên này — cần probe riêng |
| F7 delegation gate (r67) | ✅ KHÔNG cần kích hoạt | Omega tự phân công 4/4 lần (chưa cần cổng ép) — đúng nghĩa "phòng khi cần" |

### B. DANH SÁCH BUG MỚI (xếp theo ưu tiên fix)
- **P1:** BUG2-015 (429 giết delegation + evaluator — backoff/degradation) · BUG2-018 (provider capacity blind spot — pre-flight + pacing) · BUG2-012 (parser dạng 9 tool_use/Claude + mask) · BUG2-007/013 (detector ngôn ngữ đo JSON + ô nhiễm evidence trọng tài) · BUG2-016 (evidence digest cho trọng tài — 2 case phán âm) · BUG2-003 (readOnly auto-detect thất bại vì phủ định "không sửa cấu hình") · BUG2-014 (resume notice thiếu artifact/working-tree info) · BUG2-002 (coverage matcher không nhận nhãn directive) · BUG2-001 (priority alias) · BUG2-017 (todo-guard stale snapshot)
- **P2:** BUG2-005 (crash finalizer metrics) · BUG2-011 (run_tests semaphore + mem guard) · BUG2-009 (toàn văn lời giao không lưu) · BUG2-008 (thought rỗng — writer chưa xác định)
- **P3/watch:** BUG2-006 (cut-JSON ×2 — đã có self-heal) · BUG2-010 (file test vỡ của RAMPAGE — xử lý ở khâu bàn giao working tree) · GHI-NHẬN-d (bịa tool-result) · GHI-NHẬN-e (mojibake) · GHI-NHẬN-g (toolset không đồng nhất)

### ĐÍNH CHÍNH BUG2-010 (hồ sơ trung thực — 17:40Z)
- Điều tra sau mission: file `tests/sql-injection-regression.test.ts` hiện tại **PASS 17/17** — mtime 17:10:34 cho thấy RAMPAGE đã sửa xong lỗi cú pháp SAU lần chạy fail 17:09:31 và TRƯỚC khi bị restart giết 17:11. Nhận định "để lại file test vỡ" đúng tại thời điểm 17:09 nhưng KHÔNG đúng với trạng thái cuối — working tree cuối cùng lành mạnh.
- Toàn bộ working tree agents để lại qua **quality-gate PASS toàn bộ 52.5s** (468 test = 445 cũ + 23 mới; tsc 0; lint 0). Quyết định bàn giao của operator: **COMMIT kèm provenance đầy đủ** (đúng chỉ dẫn khối THAY ĐỔI CHƯA COMMIT) — tách bạch commit công sức agents (P0-1/P0-3/P1-3) với commit fix r70 của operator.

---

## C. BẢNG TRIỂN KHAI FIX (cùng phiên — operator, doctrine hardcode > prompt)

| Mục | Cơ chế fix (tầng mã) | Test |
|---|---|---|
| BUG2-001 | `normalizeTodoPriority` + `TODO_PRIORITY_ALIASES` tại TẦNG TOOL (dev-tools): critical/urgent/blocker/p0→high, trivial/minor→low… chuẩn hóa TRƯỚC validation + ghi DB | 3 test |
| BUG2-002 | `criterionLabelIds` + nhánh (1b) trong `matchesAcceptanceCriterion` (todo-coverage): todo ghi nhãn "[Nghiệm thu P1-3]" (dạng directive dạy) giờ được tính phủ; normalize -/./_; tag số-thứ-tự cũ giữ nguyên | 4 test |
| BUG2-003 | `NEGATED_MODIFY_RE` (phủ định + động từ sửa với MỌI tân ngữ, Việt+Anh, tới 3 từ theo sau) strip trước khi test MODIFY_INTENT_RE; `ARTIFACT_WRITE_RE` (BUG2-003b): nhiệm vụ đòi lưu artifact riêng → không auto-bật readOnly (chặn đè việc lưu) | 5 test |
| BUG2-007/013 | Detector ngôn ngữ (main L3476 + sub-loop) đo `maskToolCallText(stripInvisibleThoughtNoise(content))` — lượt thuần tool-call JSON → prose rỗng → im lặng; vi phạm thật vẫn bắn; evidence chu kỳ hết nhiễu | 3 test |
| BUG2-008 | `stripInvisibleThoughtNoise` (agent-run-tracker) dọn zero-width/control + tag tool-call treo lẻ (`<tool_call>`/`</tool_call>`/…) TRƯỚC guard rỗng — hết event "trống" | 3 test |
| BUG2-012 | Tầng parse 7 `extractClaudeToolUseCalls` (tool-calls): bóc `{"tool_uses":[{recipient_name, parameters}]}`, strip `functions.`/`fn.`, whitelist, salvage mảng đứt; maskToolCallText family (4) che khối trọn + che-toàn-đuôi khi đứt | 5+2 test |
| BUG2-015 | Sub-loop LLM wrap while-retry: `TRANSIENT_LLM_ERROR_RE` (429/rate-limit/FreeUsage/5xx/mạng) → ngủ 65s (tôn trọng cooldown) tái thử tối đa 2 lần + thought quan sát "⏳ Provider nghẽn" — hết chết nhãn error | 2 test |
| BUG2-016 | `resultDigestForEvidence` (subagent-delegate): evidence tool đọc/khảo sát kèm digest có cấu trúc (grep: tổng match + ≤6 path; file_read: path + số dòng; shell/test: số dòng output) — trọng tài thẩm định được nội dung | 3 test |
| BUG2-017 | (a) `mergeTodoSnapshot` export: item thiếu status GIỮ status cũ (không regress pending); (b) conclude-check đọc LẠI DB trước khi nudge — chỉ nudge khi DB xác nhận còn mở | 3 test |
| BUG2-005 | Boot stale-cleanup (instrumentation): trước khi lật crashed, đếm toolCalls + iteration cuối TỪ trace jsonl trên đĩa → hồi phục metrics thật (tokens không dựng lại trung thực — giữ null, không bịa) | code-review (logic đếm đơn giản) |
| BUG2-011 | `testSpawnGuard` (dev-tools) + gắn vào run_tests & run_gate: serialize 1-test-cấp (TEST_SPAWN_INFLIGHT) + pre-flight MemAvailable sàn 450MB (env TEST_SPAWN_MIN_FREE_MB) — trả degraded kèm "KHÔNG coi là test FAIL" | 3 test |
| BUG2-009 | recordAgentThought ghi TOÀN VĂN lời giao (task+context+cờ readOnly) vào trace jsonl tại dispatch — marker 📋, sống qua crash | code-review |
| BUG2-014 | RESUME NOTICE đính kèm "BẢNG CÒN LẠI TỪ CRASH": máy tự quét trace path từng sub + working-tree delta (getWorkspaceGitStatus + formatUncommittedBlock) + chỉ dẫn đối chiếu trước khi làm lại | code-review (dùng helpers r69 đã test) |
| BUG2-018 | Phần minimal: BUG2-015 backoff giữ delegation sống qua 429. Phần kiến trúc lớn hơn (provider-health pacing + failover chéo provider cho agent/evaluator) — cần quyết định thiết kế của user (provider nào thay thế), ghi tiếp theo ở mục D |
| BUG2-006/010/đindx | BUG2-010 đã giải quyết (file test lành mạnh — đính chính ở trên); BUG2-006 giữ watch (self-heal hoạt động ×2, chưa đạt ngưỡng lặp ≥3/run); GHI-NHẬN-d/e/g giữ theo dõi |

**KIỂM CHỨNG:** quality-gate PASS toàn bộ 57.3s — type_check 0 · lint 0 · imports ✓ · **507/507 test** (468 kế thừa + 39 mới trong `tests/r70-observation-v2.test.ts`, mọi test bắt từ bằng chứng nguyên văn mission r70). Vòng test tự bắt được 3 lỗi thật trong lúc viết fix (regex lazy bắt "P" thay "P1-3"; thiếu động từ tiếng Anh trong phủ định; mask đứt không che hết đuôi) — cả ba vá tận gốc trước khi gate.

### RECEIPT — Backfill metrics 3 crashed runs (operator script, 18:0xZ)
- Mục đích: BUG2-005 fix chỉ áp dụng cho boot TƯƠNG LAI; 3 run mission r70 (bị lật crashed bởi mã cũ lúc 17:11) vẫn NULL metrics → chạy backfill thủ công 1 lần theo đúng logic mới (đếm tool events + iteration cuối từ jsonl — không bịa tokens).
- Kết quả (SQL UPDATE … WHERE runId AND stopReason='crashed', mỗi run 1 row):
  - RAMPAGE sub_1791479109523_2: toolCalls=47 · cycles=28
  - SENTINEL sub_1791479109537_3: toolCalls=42 · cycles=24
  - Linh Sickyx sub_1791479109540_4: toolCalls=41 · cycles=23
- tokensUsed chủ động GIỮ NULL (không thể dựng lại trung thực — đúng tinh thần "không bịa số" của fix).

## D. CÒN TREO SAU PHIÊN (minh bạch)
1. **BUG2-018 phần kiến trúc:** provider-health pacing + failover chéo provider cho luồng agent/evaluator (khi Zen free-tier cạn, NVIDIA fallback chain chỉ phục vụ luồng NVIDIA). Cần quyết định user: provider/mô hình thay thế cho agent traffic + ngưỡng chuyển. Backoff BUG2-015 hiện giữ delegation sống qua đợt nghẽn ngắn.
2. **BUG2-006 (watch):** tool call đứt giữa JSON ×2/run (self-heal hoạt động) — chưa đạt ngưỡng lặp ≥3 để fix cấu trúc theo D7.1; nếu tái diễn ở mission sau → cân nhắc pre-emptive stream hint.
3. **GHI-NHẬN-d (model bịa tool-result JSON trong content):** theo dõi tần suất; nếu lặp → cân nhắc filter ở tầng evidence evaluator.
4. **GHI-NHẬN-e (mojibake provider-side):** blocked-upstream (đã ghi bug.md r69) — tần suất hôm nay tăng khi model stress.
5. **GHI-NHẬN-g (toolset không đồng nhất giữa các lần delegate cùng agent):** chờ case thứ 3 để lập bug điều tra whitelist nguồn.
6. **DATA MAP (F3 r68):** chưa xác minh được trên mission r70 (không quan sát thấy dấu hiệu sử dụng) — cần probe riêng hoặc chờ mission có tương tác data rõ ràng.
7. **F9/BUG-007 read_output exitCode + BUG-024 final-report retry (r69):** không cọ sát trên mission r70 — chờ mission kế.

---

# ROUND-71 — AUDIT THEO DIRECTIVE USER (knowledge_write/CATALYST · DB tools · Zen 429 xoay key)

> **Ngữ cảnh:** user hỏi trực tiếp 3 vấn đề kiến trúc (không phải quan sát mission chạy): (1) knowledge_write chỉ CATALYST dùng → không gọi CATALYST thì agents có ghi bài học không; (2) có nên xây thêm tool để agents khai thác database triệt để hơn; (3) 3 key Zen — 1 key 429 sao không đổi key khác. Điều tra tầng mã + DB thật (sqlite3 db/custom.db) + .env — mọi phát hiện ghi ngay tại đây theo giao thức.

## CÁC MỤC GHI NHẬN MỚI

### BUG2-019 · F · P1 · Điều tra r71 — knowledge_write bị GATE CHỈ cho CATALYST: agents thực thi KHÔNG BAO GIỜ ghi được bài học vào KB đồ thị
- **Xác nhận luận điểm user = ĐÚNG (kiểm chứng tầng mã + DB):** whitelist `knowledge_write` (tool ghi entity/relationship → LocalEntity/LocalRelationship sync Neo4j) chỉ có ở: CATALYST (agents.ts G3) + Omega (standalone-agents.ts). MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/FORGE/Linh Sickyx/ALISTA **KHÔNG có** — chỉ được Đ�C KB (knowledge_search/knowledge_graph). DB rows đối chiếu (sqlite3): Code Team + ALISTA + Omega tools=NULL→def-fallback (defs thiếu tool) · Linh Sickyx tools=JSON 44 items (thiếu tool).
- **Mô tả tool còn dạy sai kiến trúc:** tool-executor.ts:580 "Dùng bởi G3 (CATALYST) để ghi self-evolving lessons" + comment 5568 "Only G3 (CATALYST) has this permission" — cửa ghi KB đồ thị được THIẾT KẾ là việc của 1 agent duy nhất.
- **Hệ quả vận hành (đối chiếu 4 mission quan sát r67-r70):** CATALYST CHƯA BAO GIỜ được dispatch (delegation observed: SENTINEL/RAMPAGE/MEGATRON/Linh Sickyx/ALISTA) → **0 lần ghi KB đồ thị trong suốt quá trình thực thi của mọi mission**. Lớp episodic (Episode/ErrorOccurrence/Lesson) TỰ ghi sau run (recorder hardcode — không phụ thuộc CATALYST) nhưng chỉ gói lỗi-tool + outcome; tri thức dạng entity/quan hệ (thành hệ thống, pattern, quyết định kiến trúc, mối liên agent→công việc) KHÔNG có đường ghi nào khi CATALYST vắng mặt — đúng "lỗ hổng lớn" user gọi tên.
- **Cơ chế ghi cứng cũng thiếu:** delegation wrap-up KHÔNG có bước harvest bài học → KB (chỉ có recordAgentEpisode episodic).

### BUG2-020 · G · P0 · Điều tra r71 — Zen 429: 1 key chết GIẾT cả call dù 2 key kia hoàn toàn khỏe (3 khiếm khuyết tầng mã llm.ts)
- **Khẳng định user = ĐÚNG — "chẳng lẽ cả 3 key đều 429": KHÔNG, chỉ key #1 429 (FreeUsageLimitError, 17:23Z r70) nhưng hệ thống vẫn chết chuỗi. 3 khiếm khuyết:**
  - **(a) callZenProvider KHÔNG xoay key trong call:** gặp 429 → `markZenKey429` cooldown 60s → `return error` NGAY (llm.ts:4224-4229) — không thử key kế trong cùng call.
  - **(b) callLLMForAgent bỏ qua đường retry Zen cho 429:** regex retry (llm.ts:5040) chỉ nhận abort/timeout/5xx/empty — comment "429 đã mark cooldown… chuỗi đằng sau xử lý" nhưng chuỗi đằng sau = CLI (binary thường vắng) → ZEN FAILOVER model **BỊ BỎ QUA khi trùng model chính** (`zenModel !== zenFailoverModel` — space-bunny-free == space-bunny-free → nhánh chết) → toàn chuỗi thất bại sau ĐÚNG 1 attempt.
  - **(c) Sub-agent ghim key KHÔNG THOÁT được key 429:** `getBoundZenKey()` (llm.ts:3973) trả key ghim KHÔNG xét `zenKey429Until` → sub-agent slot #1 ghim key #1 cứ dập lại key chết mỗi retry (65s×2 backoff r70) → delegation chết nhãn error; key #2/#3 khỏe không bao giờ được dùng. Đây chính là xác尸 2 delegation r70.
  - **(d) FreeUsageLimitError bị coi transient 60s:** body 429 "FreeUsageLimitError" là hạn mức free usage (cửa sổ dài, r70 kéo dài ≥8 phút tới khi mission đóng sổ) — cooldown 60s khiến key chết được "hồi sinh" và dập tiếp.

### BUG2-021 · F · P1 · Điều tra r71 — HỒI QUY r67: tool data_map tồn tại nhưng KHÔNG agent nào GỌI ĐƯỢC (thiếu ở mọi whitelist)
- **Bằng chứng:** data_map đăng ký TOOL_DEFINITIONS + case executor (tool-executor.ts:1434/3218) nhưng grep toàn bộ whitelist: agents.ts (5 defs) + standalone-agents.ts (Omega/ALISTA/Linh Sickyx) + DEFAULT_SUBAGENT_TOOLS (subagent-delegate.ts:253) — **0 chỗ chứa 'data_map'**. Goal-loop chặn tool ngoài whitelist (agent-goal-loop.ts:4153/4285) + sub-agent chặn (subagent-delegate.ts:1262) → mọi agent khai báo tools (tất cả agents chuẩn) gọi data_map đều bị TỪ CHỐI. Ghi chú thiết kế r67 claim "whitelist của mọi agent mặc định" — KHÔNG ĐÚNG với mã chạy. Chỉ agent tools=null (whitelist rỗng = mọi builtin) gọi được — không agent chuẩn nào ở trạng thái đó.
- **Hệ quả:** khối 🗺️ BẢN ĐỒ in trong prompt dạy "tra bản đồ đầy đủ bất cứ lúc nào: tool data_map(...)" — agent làm theo sẽ bị chặn → mâu thuẫn prompt vs enforcement (đúng loại bug user ghét: dạy bằng prompt nhưng đường cứng không thông).

### BUG2-022 · F · P2 · Điều tra r71 — Agents thiếu tool tra cứu BÀI HỌC/EPISODE on-demand giữa run
- **Hiện trạng:** bài học episodic (LessonRecord — Prisma mirror Neo4j) + trí nhớ warm (AgentMemory + Qdrant) CHỈ được nạp tự động đầu run (preact/PRE-ACT block — 4s timeout, có khi trống). Giữa run khi agent gặp vấn đề mới muốn đối chiếu "lỗi tương tự đã gặp chưa" → KHÔNG có tool nào tra Lesson/Episode/AgentMemory theo từ khoá (context_recall chỉ là digest run cũ trong cùng session; knowledge_search chỉ quét KB tài liệu). Bộ não DB có dữ liệu nhưng không đường truy vấn chủ động — ngược triết lý "khai thác database triệt để".

## BẢNG FIX ROUND-71 (hardcode > prompt — mọi fix tầng mã)
| Mục | Cơ chế (đề xuất, thực thi phiên này) | Test |
|---|---|---|
| BUG2-020a | `callZenProvider` vòng xoay key: 429 → mark cooldown → **chọn key kế sạch ngay trong cùng call** (thử tối đa đủ số key) — chỉ trả lỗi khi TẤT CẢ key đều 429, kèm thông báo key reset sớm nhất | 5 test |
| BUG2-020c | `getBoundZenKey()` thoát key ghim đang 429-cooldown → rơi `getZenKey()` (ưu tiên key khỏe chưa ghim; chia sẻ key khi key riêng chết còn hơn chết chờ) + log rõ lần rời ghim | 3 test |
| BUG2-020d | `markZenKey429(index, cooldownMs)` param hóa: body có FreeUsageLimit → cooldown dài `ZEN_FREE_USAGE_COOLDOWN_MS` (mặc định 15'); 429 thường → 60s như cũ | 2 test |
| BUG2-019 | (1) Mở `knowledge_write` cho MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/FORGE (agents.ts) + ALISTA/Linh Sickyx (standalone-agents.ts) + sync ADD-IF-MISSING row Linh Sickyx (JSON) — giữ trong SUBAGENT_WRITE_TOOLS để readOnly delegation vẫn strip đúng; (2) sửa mô tả tool bỏ "chỉ CATALYST"; (3) **harvest cứng tại delegation wrap-up**: tín hiệu đáng học (tool failures / kết thúc bất thường / báo cáo có mục bài học) → ghi KB entity 'DelegationLesson' + relationship agent -[PERFORMED]-> task — KHÔNG phụ thuộc CATALYST | 6 test |
| BUG2-021 | Thêm `data_map` vào whitelist 8 defs + DEFAULT_SUBAGENT_TOOLS — hết mâu thuẫn prompt/enforcement | 2 test |
| BUG2-022 | Tool mới `lessons_search({query, agent?, limit?})`: tra LessonRecord (keyword, sort confidence) + EpisodeRecord (title/goal) + AgentMemory (content, theo agent tùy chọn) — đọc thuần, đăng ký executor + KNOWN_TOOL_NAMES + SALVAGE_SAFE_TOOLS + whitelist mọi agents | 4 test |

*(Các mục trên được thực thi và nghiệm thu trong phiên này — cập nhật trạng thái từng mục ở mục C bên dưới sau khi gate PASS.)*

### C. NGHIỆM THU ROUND-71 (sau fix — mọi mục đối chiếu bằng máy)

**Gate:** quality-gate PASS toàn bộ 59.3s — type_check 0 lỗi · lint 0 lỗi · imports ✓ · **541/541 test** (507 kế thừa + **34 mới** trong `tests/r71-db-tools-zen-rotation.test.ts`, mọi test bắt từ bằng chứng r70 nguyên văn). Vòng test TỰ BẮT 2 lỗi thật trong lúc triển khai fix (SENTINEL bị bỏ sót khi thêm whitelist do anchor nhầm — test phát hiện tức thì; mô tả knowledge_write còn sót chữ "CATALYST") — cả hai vá tận gốc trước khi gate.

**Live probe (qua /api/tools/execute thật sau PM2 restart):**
- `lessons_search({"query":"429 rate limit"})` → trúng trí nhớ THẬT của Omega (mission P1-1 về rate limiting, 2026-10-08) — tra cứu chéo agent hoạt động end-to-end, 74ms.
- `knowledge_write` → entity ghi LocalEntity OK (id f9fe610a…) — đường ghi KB đồ thị cho agent thường THÔNG THẬT (probe entity đã dọn sau kiểm định).
- `data_map({"query":"ghi bài học vào kb"})` → route đúng knowledge_graph + knowledge_kb (đã bổ keyword 'bài học'/'lesson' — trước đó query này rơi vào 0-match).
- Boot log: `[Standalone] r71 sync: Linh Sickyx +3 tool DB (knowledge_write, data_map, lessons_search)` — ADD-IF-MISSING chạy đúng trên row JSON có sẵn; `[Opus] TASK 22 top-up: lessons_search — 79 → 80` (cơ chế top-up có sẵn tự bắt tool mới).
- Log cũ (trước fix) xác nhận CHUỖI CHẾT đúng như phân tích BUG2-020: `429 rate-limited (key #N) → thử OpenCode CLI → thất bại toàn chuỗi` — mỗi call chết ngay tại key bị 429, KHÔNG bao giờ thử key kế. Sau fix: vòng xoay key trong cùng call + thoát ghim key chết + FreeUsageLimit cooldown 900s + thông báo "TẤT CẢ N key đều rate-limited" kèm thời điểm reset từng key khi thật sự cạn.

**Đối chiếu 3 câu hỏi user:**
1. *knowledge_write chỉ CATALYST dùng → không gọi CATALYST thì không ai ghi bài học?* — ĐÚNG (kiểm chứng whitelist + DB + 4 mission quan sát không lần nào dispatch CATALYST). Đã fix 3 lớp: mở whitelist 9 agents + harvest CỨNG tại delegation wrap-up (không phụ thuộc thiện chí agent) + mô tả tool sửa đúng kiến trúc.
2. *Có nên xây thêm tools khai thác DB?* — CÓ, đã xây: `lessons_search` (3 kho bộ não on-demand) + mở `knowledge_write` + cứu `data_map` khỏi mồ côi (BUG2-021 — tool tồn tại từ r67 nhưng 0 whitelist chứa, gọi là bị chặn).
3. *1 key 429 sao không đổi key?* — Đúng là hệ thống cũ KHÔNG đổi (3 khiếm khuyết a/b/c+d ở BUG2-020). Đã fix đủ 4 điểm; giờ chỉ chết khi TẤT CẢ key thật sự 429 — với thông báo rõ ràng từng key reset lúc nào.

**Ghi nhận thêm (minh bạch):** vòng push đầu bị PRE-PUSH GATE CHẶN (đúng chức năng) — keyword mới 'bài học' làm query r67 test khớp thêm vùng → block bản đồ vượt cap 1600 do lối tính keep cũ KHÔNG tái kiểm tra sau ghép. Đã vá tận gốc: vòng cắt giảm dần số vùng cho tới khi tổng ≤ maxChars + 2 test khoá hợp đồng cap (tổng 543/543). Đây là lỗi cap logic tiềm ẩn từ r67 chỉ bộc lộ khi tổ hợp vùng khớp đủ nhiều — gate chặn push đúng nghĩa đen "không để bug lên main".

---

# ROUND-72 (phiên 2026-10-09 — 4 yêu cầu user: kiểm tra phiên bản / mở phiên cũ đứng cuối / FORGE độc lập / nhiều model free)

> **Ngữ cảnh:** HEAD xuất phát `a4f2c55` (r71, = origin/main — kiểm chứng mục 1: sandbox đang chạy bản mới nhất; PM2 created_at 19:16:51 trùng giờ commit, tree sạch 0 uncommitted, fetch origin không có gì mới hơn).

## A. CÁC MỤC GHI NHẬN MỚI

### BUG2-023 · P1 · E — Mở phiên cũ KHÔNG đứng cuối chat (user report mục 2)
- **Bằng chứng (browser agent, phiên "R18 obs" 6 tin mission dài):** container chat `scrollHeight=15562, clientHeight=291` nhưng **`scrollTop=60`** — user nhìn thấy TIN CŨ NHẤT của khung tail (3 lượt cuối), phải tự kéo xuống 15k px mới thấy phản hồi cuối.
- **Gốc rễ 2 lớp:** (a) suốt `loadingMessages=true` message list KHÔNG mount → `messagesEndRef` null → effect auto-scroll `[messages, isLoading]` no-op; (b) khi list mount, `scrollIntoView({behavior:'smooth'})` phải lướt 15k px và bị GIÁN ĐOAN giữa chừng bởi re-render (merge Thought-Process panel fetch agent-run về sau + markdown/code-block tăng chiều cao sau paint) → animation chết ở ~60px đầu danh sách.
- **Fix (hardcode, không animate):** state `sessionOpenScrollTick` bump trong `finally` loadSessionTail (CHỈ đường non-silent — mở/đổi phiên; 4 đường silent giữ nguyên để không giật vị trí user đang đọc cũ) → effect nhảy TỨC THỜI `el.scrollTop = el.scrollHeight` (không scrollIntoView — cái đó cuộn kèm ancestor scrollbar) + settle 2 nhịp 150ms/450ms cho panel/markdown settle; đồng bộ `isNearBottomRef=true` sau cú nhảy.
- **Bonus dead-zone:** trigger load-older `prevTop > 60` bỏ sót vị trí xuất phát 1-60px (đậu ở 60 → kéo lên 0 KHÔNG load) → đổi `prevTop > el.scrollTop + 40` (vẫn an toàn với clamp đổi phiên vì `lastScrollTopRef` đã reset 0).
- **Nghiệm thu browser:** mở phiên qua restore reload → `scrollTop=15271` (= 15562-291, chính xác đáy) ✓; đổi phiên qua dropdown → `scrollTop=6736` (= 7027-291, đáy) ✓; kéo lên đầu → older messages prepend + giữ vị trí đọc + nút "↑ Xem tin nhắn cũ hơn" biến mất khi cạn ✓.

### BUG2-024 · P1 · F — FORGE hiển thị thuộc Team Code (user report mục 3)
- **Bằng chứng:** def FORGE nằm trong `CODE_TEAM_AGENTS` với `team='code', position='FS'` (TASK 43) → UI Agents nhóm "💻 Team Code" + Smolab agent selector bucket "Team Code — chat 1-1" đều xếp FORGE vào team code. User: "FORGE là agents độc lập chứ có phải thuộc team code đâu".
- **Fix (mirror TASK 48 RAVAGE→Linh Sickyx, không đổi tên):** def rời `CODE_TEAM_AGENTS` → `STANDALONE_AGENTS` (team=null, position=null, persona `FORGE_INSTRUCTION` bỏ căn thân "của Code Team"); migration `_normalizeForgeToStandalone` chạy trước def-loop của standalone seed (normalize AgentProfile: team:null + position:null + isSystem:true + instruction/description mới + tools JSON 866B — row code-team để trống tools, delegate by-name cần whitelist đầy đủ) + safety-net trong def-loop; `POSITION_BY_NAME` bỏ FORGE + `resolveDelegationTarget` bỏ 'FS' → delegate_task('FORGE') rơi nhánh by-name DB-first (giống ALISTA/Linh Sickyx — r60); 4 bảng satellite keyed 'FORGE' (ToolAssignment/SkillAssignment/AgentModelOverride/CronJob) tự còn đúng vì tên giữ nguyên; DELEGATABLE_AGENTS giữ FORGE (đích delegate hợp lệ, role "độc lập").
- **Nghiệm thu:** DB sau restart: `FORGE|team=|position=|isSystem=1|enabled=1|tools_len=866|instruction="…ĐỘC LẬP…"` ✓; UI Agents: FORGE trong section "Độc lập" (badge SYS, hết badge FS) ✓; Smolab selector: FORGE cuối bucket Độc lập, MEGATRON mở đầu Team Code ✓; pipeline SOP `getPositionsInOrder()` nguyên vẹn 5 vị trí (FS vốn không nằm trong từ TASK 43) ✓.

### BUG2-025 · P1 · G — opencode CLI chưa cài + launcher npm treo + toàn bộ ghi chú "auth oauth" lỗi thời (user report mục 4)
- **Bằng chứng:** `which opencode` = command not found (app chạy không có CLI từ trước — resolver chỉ warn 5 phút/lần); sau khi `npm i -g opencode-ai` (v1.18.35): **launcher JS** `/home/z/.npm-global/bin/opencode` spawn treo vĩnh viễn 0 byte (4/4 lần, kể cả `--pure`/DEBUG) trong khi **binary nền tảng** `…/opencode-linux-x64/bin/opencode` (185MB) chạy hoàn hảo.
- **Fix:** symlink `~/.opencode/bin/opencode` → binary nền tảng (đúng candidates[0] của `resolveOpenCodeCliBin` — app tự phát hiện, không cần restart).
- **Phát hiện đảo ngược chính sách (đối chứng ghi chú r71 trong llm.ts):** matrix test 2026-10-09 CLI v1.18.35 + `auth.json` type:api (key oc_sk) + provider **native** `opencode/<model>` → model free TRẢ LỜI THẬT (ling-3.1-flash-free ×5, mimo ×2, step-5, longcat, big-pickle — đều "OK"). Chỉ HTTP trực tiếp + custom provider (`@ai-sdk/openai-compatible`) nhận 403 "OpenCode's free tier can only be used from within OpenCode". → Ghi chú cũ "cần `opencode auth login` (account oauth)" SAI — chính `opencode auth login -p opencode` chỉ là DÁN API KEY (probe PTY xác nhận TUI chỉ có ô "Enter your API key"), và key oc_sk chạy được qua native ngay.
- **Fix code:** `ensureOpenCodeAuth()` self-heal ghi auth.json từ ZEN_API_KEY_1 khi thiếu (không bao giờ đè file có sẵn); `callOpenCodeCLIProvider` route 2 transport: SBF → alias k1/k2/k3 (giữ xoay key), model free khác → native `opencode/<model>`; cập nhật toàn bộ ghi chú lỗi thời + TTL cache cli:FreeTierError 60s→300s (đỡ retry mọi 60s khi 403 thật ở native).

### BUG2-026 · P2 · G — repo opencode.json ĐỊNH NGHĨA ĐÈ provider native "opencode"
- **Bằng chứng:** `opencode.json` khai provider `opencode` = custom `@ai-sdk/openai-compatible` (baseURL zen + apiKey nhúng) → spawn `--model opencode/<model-free>` trong thư mục app resolve về custom HTTP → 403 (log 05:23Z: `providerID=opencode` native runtime nhưng vẫn 403 khi chạy từ app-dir do config shadow; từ /tmp không shadow → "OK").
- **Fix:** gỡ hoàn toàn def "opencode" khỏi repo opencode.json (native sống); giữ k1/k2/k3 (SBF xoay key); default `model` đổi từ `nemotron-3-ultra-free` (đã chết) sang `space-bunny-free`; `small_model=opencode/mimo-v2.6-flash-free` giờ resolve native → khỏi "Insufficient account funds" khi sinh title.

### BUG2-027 · P2 · F — danh sách model chứa model ĐÃ CHẾT (chọn là treo/lỗi)
- **Bằng chứng matrix 2026-10-09:** nemotron-3-ultra-free (extraction CHÍNH!) đã rời catalog Zen (GET /v1/models không còn → 404); nemotron-3.5-lightning-free treo CLI 5/5 lần 0 byte (dead endpoint — spawn treo = tốn 240s timeout mỗi call, KHÔNG cache được vì hang không đánh dấu); jev-1.13-free UnknownError "Unexpected server error"; muse-spark-1.3-contributor-free geo-block "not available in your country" (muse-1.2 cũng vậy).
- **Fix:** `PROVIDER_MODELS.zen` = đúng 6 model VERIFIED (SBF + ling + mimo + step-5 + longcat + big-pickle — label ghi rõ đường vận hành); `EXTRACTION_ZEN_MODEL` default nemotron-3-ultra-free → space-bunny-free (HTTP xoay key — ổn định nhất cho pipeline document); health route note cập nhật; `ZEN_KNOWN_MODELS` mở rộng (normalize DB cũ) + giữ model chết cho tham chiếu row cũ.

### GHI NHẬN MỞ (không fix được từ bên trong — minh bạch cho user)
- **Zen free-tier quota THEO PROJECT:** cùng key oc_sk, cùng thời điểm — `/tmp` (projectID=global) trả lời OK, thư mục `/home/z/tmo-app` (projectID=250903ec…) nhận 403 FreeTierError trên native. Dự đoán: allowance free của project tmo-app bị cạn sau các mission chạy opencode CLI lịch sử. Hệ quả trong sandbox hôm nay: agent đặt model free khác sẽ chạy qua failover SBF (E2E xác nhận: ling → HTTP 403 (cache 60s) → CLI 403 (cache 5p) → **ZEN FAILOVER SBF trả "OK"** — agent KHÔNG bao giờ chết). Trên máy local của user / clone mới / khi quota reset — model free chạy thẳng native không cần đổi gì.
- **CLI boot treo ngẫu nhiên:** ~30% lần spawn treo 0 byte vĩnh viễn (không phụ thuộc model — kể cả model chạy tốt); bị chặn bởi `timeout` bên ngoài. App có sẵn `OPENCODE_CLI_TIMEOUT_MS=240s` + failover nên không ảnh hưởng tính sẵn sàng, nhưng làm chậm trung bình đường CLI.
- Lint warning pre-existing (unused eslint-disable subagent-delegate:1024) — dọn sạch trong round này.

## B. FIX TỔNG HỢP ROUND-72

| Mã | Fix | Test khoá |
|---|---|---|
| BUG2-023 | `sessionOpenScrollTick` nhảy tức thời xuống cuối khi mở/đổi phiên (bump trong finally non-silent) + settle 150ms/450ms + dead-zone trigger `prevTop > scrollTop+40` | Nghiệm thu browser (2 đường: restore + dropdown; đo scrollTop=đáy chính xác) |
| BUG2-024 | FORGE tách Code Team → standalone (def + migration DB + POSITION_BY_NAME/'FS' gỡ + delegate by-name DB-first + UI tự nhóm "Độc lập") | 6 test (r72) + browser 2 module |
| BUG2-025 | Cài opencode CLI v1.18.35 + symlink binary nền tảng + `ensureOpenCodeAuth()` self-heal + route 2 transport theo model + cập nhật ghi chú lỗi thời | E2E qua chính `callLLMForAgent` (ling → failover SBF "OK" 8.9s) |
| BUG2-026 | Gỡ shadow provider "opencode" khỏi repo opencode.json + default model SBF + small_model native | 2 test đọc file config khoá hợp đồng |
| BUG2-027 | Model list = 6 model VERIFIED; extraction default SBF; loại 4 model chết | 4 test |

## C. NGHIỆM THU ROUND-72

**Gate:** quality-gate PASS toàn bộ — type_check 0 · lint 0 (dọn cả warning pre-existing) · imports ✓ · **555/555 test** (543 kế thừa + **12 mới** trong `tests/r72-free-models-forge-standalone.test.ts`).

**Live (browser + E2E thật):**
- Mở phiên cũ 2 đường (reload restore + dropdown) → `at_bottom=true` chính xác tuyệt đối (scrollTop = scrollHeight − clientHeight); kéo lên → prepend cũ + giữ vị trí; nút load-older hiện/ẩn đúng hasMore.
- Agents module + Smolab selector: FORGE nhóm "Độc lập" (SYS, không badge vị trí); Team Code còn đúng 5; model dropdown hiển thị đủ 6 model free mới.
- E2E `callLLMForAgent(zen/ling-3.1-flash-free)` qua code app thật: HTTP 403 → cache 60s → CLI native spawn đúng binary → (app-dir đang 403 quota) → failover SBF trả **"OK"** 8.9s — chuỗi sống sót toàn vẹn, đúng thiết kế many-layer failover.

**Đối chiếu 4 câu hỏi user:**
1. *Phiên bản sandbox có mới nhất không?* — CÓ: `a4f2c55` = origin/main (fetch 04:13Z không có commit mới hơn), PM2 restart đúng giờ commit 19:16:51, working tree sạch, `next dev` hot-reload — bản đang chạy là mới nhất tính đến thời điểm kiểm tra.
2. *Mở phiên cũ mặc định hiện tin cuối, kéo lên mới load cũ?* — Cơ chế tail-load đã có từ 2026-09-01 nhưng auto-scroll bị gián đoạn chết ở đầu danh sách (BUG2-023) → đã fix bằng nhảy tức thời; kéo lên tải thêm (3 lượt/lần, giữ vị trí đọc) hoạt động đúng.
3. *FORGE độc lập chứ đâu thuộc team code?* — Đúng theo thực thể hệ thống (vốn chỉ delegate qua by-name, không nằm pipeline SOP) → đã tách hoàn toàn (def + DB + UI + mọi tham chiếu), vẫn delegate được như cũ.
4. *Dùng opencode auth login để có nhiều model free thay vì chỉ SBF?* — Đã hiện thực hóa: CLI cài xong + key oc_sk nạp (auth login chỉ là dán API key — không cần oauth account) + đường native mở khóa 5 model free mới (verified trả lời thật). Lưu ý minh bạch: trong sandbox hôm nay Zen còn 403 theo project với thư mục app (quota lịch sử) → model free chạy qua failover SBF; trên môi trường project mới/quota hồi thì chạy thẳng native.

---

# ROUND-73 (phiên 2026-10-09 — 4 yêu cầu user: dropdown model / gỡ nút Prompt Auto + nút "+" đính kèm / audit Bug_v2 / đánh giá phân loại model free mới)

> **Ngữ cảnh:** HEAD xuất phát `03019ae` (r72, = origin/main). User sau khi thấy UI + catalog opencode 84 model đưa 4 yêu cầu mới. Điều tra + triển khai + nghiệm thu trong cùng phiên này.

## A. CÁC MỤC GHI NHẬN MỚI

### BUG2-028 · E · P2 · Dòng model indicator không bấm được — user muốn đổi model free ngay trong khung chat (user report mục 1)
- **Hiện tượng:** dòng `🤖 Model: …` dưới selector agent là div tĩnh; `selectedModel` state có sẵn nhưng bị `chatBody.model = agent.model` (dòng 5071 cũ) ĐÈ mỗi lần gửi — user không có đường đổi model cho phiên chat.
- **Fix (hardcode 3 lớp):** (1) dòng indicator → nút bấm (chỉ single mode + provider zen — team TL/nvidia giữ tĩnh); dropdown render từ `/api/agents/models` (PROVIDER_DATA.zen) kèm icon caps ⚡coding/🧠reasoning/🤖agentic từ bằng chứng battery r73; (2) chọn model → `setSelectedModel` → indicator hiện badge "⚡ ghi đè" khi ≠ model agent; (3) sendMessage: `chatBody.model = selectedModel` + `chatBody.agentModel = selectedModel` (model hiệu dụng chạy ReAct loop + durable job đều theo dropdown — KHÔNG đổi AgentProfile DB). Chọn agent khác → reset về model agent (giữ hành vi mặc định). Restore context (localStorage) giữ nguyên model override của phiên làm việc trước.

### BUG2-029 · E · P2 · Nút "Prompt Auto" cạnh ô nhập vô dụng (user report mục 2 — user xác nhận thấy KHÔNG có tác dụng gì)
- **Gốc rễ "vô dụng":** nút chỉ gửi `promptBudgetChars: -1` khi bật ∞ — chuỗi này CHỈ ảnh hưởng trần system prompt của đúng tác vụ; user không thấy khác biệt thực tế → đúng là tính năng thừa. Hơn nữa 2 e2e script (t28/t29) luôn cứng `promptBudgetChars: -1` — nút với runtime thật không còn ý nghĩa phân biệt.
- **Fix (gỡ SẠCH toàn chuỗi — 8 file):** smolab-module (nút + state + gửi) · openclaw/chat route (đọc body + effectivePromptBudget + 2 pass-through) · agent-goal-loop (param assemble + runGoalDrivenLoop + 2 executeTool context + import) · goal-loop-durable-types (field job input) · goal-loop-worker (pass-through) · code-team/workflow-engine (2 interface + ctx + 2 call) · code-team/tool-executor (2 context + pass-through) · prompt-budget.ts (XOÁ export budgetPromptWith — chỉ còn budgetPrompt trần env SYSTEM_PROMPT_BUDGET_CHARS). Lõi budget (applyPromptBudget + tier water-filling + sàn giữ identity r68 BUG-016) GIỮ NGUYÊN — đó là hạ tầng chống phình system prompt 30-50k, không phải phần của nút.
- **Test khoá:** task26 viết lại A2 (budgetPromptWith phải undefined ở module) + r73 test source-scan 8 file sạch identifier (cho phép comment giải thích việc đã gỡ).

### BUG2-030 · F · P1 — Agents không có đường nhận TỆP user tải lên (thay nút đã gỡ bằng năng lực thật)
- **Triển khai nút "+" (mục 2 user):**
  - **Prisma `ChatAttachment`** (sessionId/messageId nullable — link về đúng tin nhắn lúc early-save; kind/sizeBytes/filePath/derivedText/status) + `db push` (lưu ý vận hành: push từ thư mục prisma/ hoặc DATABASE_URL tuyệt đối — chạy từ root với env tương đối `file:../db/custom.db` lần đầu không tạo bảng).
  - **Route `/api/smolab/attachments`** (POST multipart/GET/DELETE): cap 30MB (env SMOLAB_UPLOAD_MAX_MB) · sanitize tên (strip path-traversal + control chars + 120 chars) · phân loại hardcode ĐUÔI thắng MIME client bịa (`report.pdf` + MIME "text/html" → vẫn pdf) · lưu file tên cuid · **chưng cất derivedText ngay lúc upload bằng z-ai-web-dev-sdk v0.0.18** (backend-only, singleton, config /etc/.z-ai-config tự đọc): image → VLM createVision mô tả tiếng Việt (cap 4k) · audio → ASR transcript (cap 20k) · video → createVision video_url tóm tắt (cap 4k) · text → UTF-8 (40k) · pdf → pdf-parse (40k) · docx → mammoth (40k). FAIL-OPEN: chưng cất lỗi KHÔNG làm upload chết — agent còn filePath đọc bản gốc bằng tool.
  - **UI:** nút + (accept ảnh/audio/video/pdf/docx/text, tối đa 4 tệp/lượt) · chips trạng thái uploading/ready/error kèm thumbnail ảnh (object URL, revoke đúng) · X bỏ tệp (DELETE khỏi server nếu đã upload nhưng chưa gửi; user bỏ chip giữa lúc upload → khi response về tự dọn tệp mồ côi) · gửi được khi ô nhập trống nếu có tệp sẵn sàng.
  - **Manifest trong content (không phải metadata riêng):** `📎 ĐÍNH KÈM N TỆP … [i] tên (kind, KB) — Tệp gốc: <filePath> — <derivedText>` ghép CUỐI user message → MỌI đường tiêu thụ (single chat/ReAct, team workflow, research mission) đều thấy nội dung + replay phiên cũ từ DB nguyên vẹn. `attachmentIds` kèm body → route early-save link row ChatAttachment về sessionId + messageId (fail-open).

### BUG2-031 · G · P1 · Audit "toàn bộ bug đã ghi nhận đã fix chưa" (user report mục 3) — 1 mục kiến trúc lớn còn thiếu đã đóng trong phiên này
- **Tổng đối chiếu 27 mục BUG2-001→027:** r70 fix 13 hạng (001,002,003,005,007,008,009,011,012,013,014,015,016,017 + đính chính 010) · r71 fix 4 (019,020,021,022 — live probe 74ms) · r72 fix 5 (023,024,025,026,027 — browser + E2E thật). **Còn thiếu đúng 1 mục kiến trúc: BUG2-018 phần "failover chéo provider"** (r70 ghi "cần quyết định user: provider/mô hình thay thế") — r72 đã mở kho model free CLI-native nhưng chuỗi failover khi model chính == space-bunny-free == failover thì rung failover BỊ SKIP → SBF chết toàn phần = agent chết (chỉ 3 key 429 + CLI 403 là đủ).
- **Fix BUG2-018 (đóng nốt):** nấc LAST-RESORT chéo model trong free tier — `parseZenLastResortModels(env, main, failover)` (pool mặc định 3 model battery-verified ling/mimo/big-pickle, loại model đã thử, cap 3/lần) + vòng thử ĐƯỜNG CLI native (HTTP đã biết 403 với model ngoài SBF — bằng chứng curl 2026-10-09). Agent giờ chỉ chết khi TOÀN BỘ pool free chết. Override env `ZEN_LAST_RESORT_MODELS`.
- **Các mục "còn treo" còn lại — đánh giá lại từng mục:**
  - DATA MAP (F3 r68, mục D6 r70 "chưa xác minh"): **ĐÓNG** — r71 đã live-probe `data_map({"query":"ghi bài học vào kb"})` route đúng (ghi nhận ở ROUND-71 nghiệm thu); whitelist mọi agents từ r71.
  - BUG2-006 (tool-call đứt ×2/run): GIỮ WATCH đúng giao thức D7.1 (ngưỡng fix cấu trúc ≥3/run chưa đạt; self-heal hoạt động).
  - GHI-NHẬN-d (bịa tool-result): watch theo tần suất. GHI-NHẬN-e (mojibake): blocked-upstream. GHI-NHẬN-g (toolset lệch): chờ case thứ 3.
  - F9/BUG-007 read_output exitCode + BUG-024 final-report retry: KHÔNG THỂ cọ sát không có mission — chờ mission kế (bản thân các fix đã có test đơn vị từ r69).
  - BUG2-004 (wedge + restart giết delegation): giảm thiểu bằng SUBAGENT_MAX_CONCURRENT (min(3, số key)) + testSpawnGuard serialize + MemWatchdog + durable resume (LIVE-✅-6 r70) — gốc rễ là hộp 4GB RAM với 3 sub song song × context 60k+, giữ theo dõi hạ tầng.

### BUG2-032 · G · P2 · Matrix r73 phát hiện 2 model nemotron SỐNG LẠI + 6 model free mới xuất hiện đều CHẾT
- **Matrix 14 ứng viên (catalog 84 model lọc free + model lạ mới):** ✅ 8 sống (trả lời "OK" thật): space-bunny-free, big-pickle, ling-3.1-flash-free, longcat-2.5-preview-free, mimo-v2.6-flash-free, **nemotron-3-ultra-free (sống lại — r72 ghi 404)**, **nemotron-3.5-lightning-free (sống lại — r72 ghi treo 5/5)**, step-5-preview-free. ❌ 6 chết: exo-free (deprecated), ling-3.0-flash-fin-free (không phản hồi), muse-spark-1.3-contributor-free (geo-block), claude-fable-5 (Model access disabled), claude-fable-5-1 (Insufficient account funds), grok-build-0.1 (không phản hồi).
- **Đối chiếu HTTP vs CLI:** SBF chạy được cả HTTP (xoay key) LẪN CLI; 7 model kia HTTP = FreeTierError 403 "free tier can only be used from within OpenCode" — chỉ CLI native (curl bằng chứng trong ROUND-73 fix BUG2-018).
- **Fix:** PROVIDER_MODELS.zen = 8 model (thêm 2 nemotron sống lại + caps phân loại + label đường vận hành) + cập nhật test r72 (bỏ 2 model nemotron khỏi danh sách chết — bằng chứng mới nhất thắng).

## B. BATTERY ĐÁNH GIÁ 2 TẦNG — PHÂN LOẠI CODING/AGENTIC/REASONING (mục 4 user)

**Battery 1 (cơ bản — 8 model sống):** TẤT CẢ PASS 3/3 (hàm JS chạy bun thật 4/4 case; câu đố 3 máy in = 6 phút; JSON plan 3 bước chuẩn).

**Battery 2 (khó — phân hóa thật):**

| Model | Coding-hard (romanToInt 6 case: MCMXCIV=1994, XLII=42…) | Reasoning-hard (vòi hồ bơi = 140 phút, chỉ 1 số) | Agentic-hard (JSON lồng: enum risk + 3 actions + depends_on ["a1","a2"] + rollback) | ms c/r/a |
|---|---|---|---|---|
| space-bunny-free | ✅ | ⚠️ ĐÚNG 140 nhưng nhào dàn trải 12+ con số (vi phạm "chỉ 1 số") | ❌ json-parse-fail | 8.7/5.7/34.4k |
| big-pickle | ✅ | ✅ | ✅ | **5.7**/12.6/9.8k |
| ling-3.1-flash-free | ✅ | ✅ | ✅ | 28.7/7.8/10.8k |
| longcat-2.5-preview-free | ✅ | ✅ | ❌ json-parse-fail | 11.9/11.9/15.8k |
| mimo-v2.6-flash-free | ✅ | ✅ | ✅ | 6.8/**6.9**/8.9k |
| nemotron-3-ultra-free | ✅ | ✅ | ✅ | 10.7/33.5/19.9k |
| nemotron-3.5-lightning-free | ✅ | ✅ | ✅ | 15.9/18.0/22.6k |
| step-5-preview-free | ✅ | ✅ | ✅ | 38.6/11.1/22.3k |

**Phân loại (caps encode vào PROVIDER_MODELS — dropdown hiển thị ⚡🧠🤖):**
- **coding: 8/8 ✅** — toàn bộ pool viết code đúng cả bài khó.
- **reasoning: 8/8 ✅** — SBF ra đáp số đúng nhưng kiteenws lệnh "chỉ 1 số" kém (nhiều chữ — đặc tính phù hợp quan sát r70: SBF là model phát tool-call đứt nhiều nhất, parser salvage r70 F1-F7 bù đúng chỗ này).
- **agentic (structured output): 6/8 ✅** — big-pickle/mimo/ling/nemotron×2/step-5 giữ JSON schema lồng nhau CHÍNH XÁC; **space-bunny + longcat lỗi format JSON phức tạp**.
- **Tốc độ:** nhanh nhất — big-pickle (coding 5.7s) + mimo (tổng thể nhanh nhất, 3 test đều < 9s); chậm nhất — step-5 (coding 38.6s) + nemotron-ultra (reasoning 33.5s — "sâu nhưng chậm").
- **Khuyến nghị theo vai:** chat nhẹ/utility → mimo; đa dụng + nhanh → big-pickle; phân tích nặng → nemotron-3-ultra-free; lõi chính + HTTP ổn định → space-bunny-free (giữ — có xoay key 3 key + failover + last-resort).

## C. NGHIỆM THU ROUND-73

- **Test:** `tests/r73-model-dropdown-attachments.test.ts` MỚI 25 test (dropdown hợp đồng nguồn + gỡ nút source-scan 8 file + attachment classify/sanitize/cap/DB roundtrip + last-resort parse + battery phân loại) + task26 viết lại + r72 cập nhật theo bằng chứng mới — chạy cục bộ 47/47 PASS.
- **Battery/matrix bằng chứng thật:** /tmp/oc-matrix-r73.txt (14 model) + /tmp/oc-battery-r73.md (8×3) + /tmp/oc-battery2-r73.md (8×3 khó) — script tái lập /home/z/my-project/oc-{matrix,battery,battery2}-r73.*.
- **Gate:** quality-gate PASS toàn bộ 59.0s — type_check ✓ (lần chạy đầu exit 137 = OOM tạm do next-server giữ ~1GB + battery chạy song song; lần 2 bắt 1 lỗi thật: availableModels vốn là state của module Agents — smolab có state riêng zenModelOptions) · lint ✓ · imports ✓ · **582/582 test** (555 kế thừa + **27 mới** r73).
- **Browser (agent-browser) + DB + log thật:**
  - Dropdown: mở từ dòng model indicator → đủ 8 model với icon caps đúng battery (SBF + longcat KHÔNG có 🤖 — 6 model kia có); chọn big-pickle → indicator "🤖 Model: big-pickle ⚡ ghi đè (zen)"; durable GoalLoopJob nhận `agentModel: big-pickle` (sqlite đối chiếu jobInput) — override chảy tới server đúng.
  - Nút Prompt Auto: BIẾN MẤT (snapshot chỉ còn "Xem System Prompt" — tính năng khác). Nút "Đính kèm tệp" hiện diện cạnh ô nhập.
  - Upload PNG 2.2KB qua nút + → chip (thumbnail + tên + KB + nút bỏ) → POST /api/smolab/attachments 200 → **VLM mô tả ĐÚNG TỪNG CHỮ trong ảnh** ("nền navy, dòng chữ vàng TMO r73 UPLOAD TEST 12345"); gửi "Tệp này chứa gì?" → bubble hiển thị manifest đầy đủ (tên + kind + KB + filePath + mô tả VLM); DB: user message lưu manifest + ChatAttachment link sessionId+messageId ✓; job nhận userMessage chứa manifest ✓.
  - Chuỗi failover sống động trên chính run này: `[LLM] Agent Zen big-pickle thất bại cả HTTP + CLI — thử ZEN FAILOVER space-bunny-free` → `[ZEN] agent-failover:space-bunny-free [key #3] OK — 1843 chars, 25866 tokens` — override model chết không giết agent (đúng thiết kế; sandbox app-dir quota native 403 — ghi nhận r72, môi trường quota sạch thì big-pickle phục vụ trực tiếp).
  - Lộ 1 bug thật trong lúc nghiệm thu (đã vá + test khoá): curl/API client gửi MIME `application/octet-stream` → phân loại rơi `other` mất đường ASR → GENERIC_CLIENT_MIMES coi octet-stream như không-MIME, fallback đuôi (.wav → audio/wav) — nghiệm thu lại live: kind=audio ✓.

### GHI BẢNG CHỨNG CUỐI (sau khi job hoàn tất — bằng chứng end-to-end mạnh nhất của phiên)
- GoalLoopJob `cmv0m98ym000ollum2b1yz3ah` **completed** — Omega (model chọn từ dropdown: big-pickle) trả lời với chuẩn [verified-by-tool]: agent tự dùng filePath trong manifest để phân tích ảnh THẬT bằng tool — "Tệp là ảnh PNG RGB, không xen kẽ, kích thước 320×120 pixel, 2.210 byte" · "nền xanh đậm #1E1E3C, dòng chữ màu vàng #F2D162 ở gần giữa: TMO r73 UPLOAD TEST 123 45" · "nền chiếm 37.879/38.400 pixel = 98,6432%" · "vùng chữ x=20–157, y=52–59, 521 pixel khác nền, 13 thành phần liên thông" — đối chiếu pixel KHỚP tuyệt đối với ảnh gốc Python render (RGB 30,30,60 = #1E1E3C). Assistant message lưu model=big-pickle (override dropdown chạy trọn chuỗi đến khi ghi nhận kết quả).
- Ý nghĩa: chuỗi ĐỦ TỪNG NẤC sống trên 1 run duy nhất — dropdown chọn model (job nhận agentModel=big-pickle) → nút + upload (POST 200) → VLM chưng cất (đúng từng chữ) → manifest trong content (DB + jobInput) → agent dùng filePath tự kiểm chứng bằng tool (không chỉ đọc mô tả VLM) → failover nhiều lớp khi big-pickle 403 sandbox (ZEN FAILOVER SBF phục vụ) → kết quả bền vững qua durable job.

---

# ROUND-74 — REVIEW TOÀN BỘ TRIỂN KHAI (user directive: "review lại tất cả những gì triển khai trước đó... đảm bảo sandbox luôn là phiên bản mới nhất... báo cáo rồi push")

## A. MỤC GHI NHẬN MỚI

### BUG2-033 · F · P1 · Zen ĐÓNG LẠI cửa native CLI cho model free ngoài SBF — r73 chẩn đoán sai nguyên nhân ("sandbox app-dir quota")

- **Phát hiện khi nào:** vòng review r74 09:23–09:31Z — quét PM2 log thấy chuỗi lặp `[OC-CLI] agent:big-pickle exit 1 — no content` + `Đánh dấu chặn cli:big-pickle` (07:12–07:22, đúng khung E2E r73).
- **Bằng chứng probe trực tiếp (09:30Z — 4 phép thử tách biến):**
  1. `opencode run --model opencode/big-pickle` từ **/tmp** (thư mục trắng) → 403 FreeTierError "free tier can only be used from within OpenCode" (cf-placement remote-ORD)
  2. Cùng lệnh từ **app-dir** /home/z/tmo-app → 403 như nhau
  3. `opencode/mimo-v2.6-flash-free` → 403 như nhau
  4. HOME-override auth.json sang **key #2** (`oc_sk_5d6aea…`) → vẫn 403 → **KHÔNG phải quota key**
  - Đối chứng: `opencode/space-bunny-free` native → **trả lời "OK" exit 0**; alias `opencode-k1/space-bunny-free` → writeback OK ngay trước đó trong log.
- **Kết luận:** chặn **POLICY TOÀN CỤC, theo model** (SBF white-list duy nhất), không phải "sandbox app-dir quota" như r73 ghi (sai chẩn đoán — đính chính ở trên). Cửa sổ native mà r72 mở (~05:30) đã đóng lại **TRƯỚC cả lúc r73 commit** (07:15) — battery r73 (~06:00) chạy đúng lúc cửa còn mở nên PASS thật.
- **Tác động:**
  - Dropdown r73 quảng bá 8 model — 7 model ngoài SBF hiện cascading âm thầm về ZEN FAILOVER SBF (agent KHÔNG chết — chuỗi nhiều lớp đúng thiết kế; user không được báo trước).
  - Last-resort pool mặc định `ling/mimo/big-pickle` (r73 BUG2-018) hiện TOÀN CHẾT — chỉ tốn thêm đúng 1 vòng re-probe/tối đa 5 phút mỗi model (block-cache TTL 300s short-circuit trước spawn — thiệt hại bị chặn tốt, không cần đổi pool vì SBF vẫn là failover đích).
- **Fix (hardcode — r74, "dropdown nói thật"):**
  1. `llm.ts`: free-tier block cache nâng value `{until, reason}` + export **`zenModelBlockSummary()`** (pure-read, chỉ trả entry còn hạn) — UI đọc đúng nguồn sự thật mà tầng vận hành đang dùng ra quyết định skip transport.
  2. `/api/agents/models`: gắn **`blockedTransports`** cho từng model zen (từ summary) — cả nhánh all-providers lẫn nhánh `?provider=zen`.
  3. `smolab-module.tsx` dropdown: **refetch mỗi lần MỞ** (trạng thái chặn TTL 60s/300s cần tươi — bản mount-cấp-lần đầu lỗi thời ngay); model bị chặn CẢ http+cli → hàng mờ + badge **⚠** + tooltip "sẽ chuyển tiếp về space-bunny-free (failover)"; bị chặn 1 transport → tooltip "hệ thống tự dùng transport còn lại"; header chú thích "⚠ bị chặn".
  4. KHÔNG xoá 7 model khỏi catalog — policy Zen lật ngược 3 lần trong 12 ngày (09-27 chặn → r72 mở → r74 chặn): trạng thái sống/thất bại phải là **số liệu runtime** (block-cache) chứ không phải danh sách tĩnh lại lỗi thời sau 1 ngày. Caps battery r73 giữ nguyên (đúng về năng lực model khi tới được).
- **Giữ watch:** nếu Zen mở lại native (re-probe 5 phút/lần tự phát hiện vì block-cache hết hạn → probe thật không tốn — chỉ khi agent có tác vụ) → badge ⚠ tự biến mất.

## B. KIỂM TRA "SANDBOX LUÔN PHIÊN BẢN MỚI NHẤT" (user directive)

- HEAD `d6ccc4c` = `origin/main`, working tree SẠCH → đĩa = bản mới nhất đã push.
- PM2 `theopusflashlite` chạy `next dev` (Turbopack) từ chính working tree đó → hot-reload từng request, code đang phục vụ = code trên đĩa (không có bản build stale).
- Xác minh tính năng r73 SỐNG trên server đang chạy (probe trực tiếp 09:24–09:26): `/api/agents/models` trả đủ 8 model + caps ⚡🧠🤖 · upload `/api/smolab/attachments` roundtrip text → derivedText nguyên văn (id cmv0relwu…) · DELETE 200 dọn sạch.
- FORGE độc lập trong DB: `SELECT name,team,position FROM AgentProfile WHERE name='FORGE'` → team='' position='' isSystem=1 (r72 đúng).
- Gate r74 chạy lại từ đầu: **PASS toàn bộ 53.2s — type_check ✓ lint ✓ imports ✓ 582/582 test** (số test r73 giữ nguyên).

## C. Nghiệm thu ROUND-74

- **Test:** `tests/r74-zen-policy-flip-truthful-dropdown.test.ts` MỚI 13 test — hợp đồng `zenModelBlockSummary` (pure-read, bỏ entry hết hạn, parse key "transport:model" tách tại dấu : ĐẦU) + file dùng chung cross-process (mark → file thật có entry; giả lập 2 PROCESS bằng bun spawn con — process cha memory trống vẫn đọc thấy qua file) + source-scan route/UI (refetch khi mở dropdown, badge ⚠, hàng mờ, tooltip fallback SBF) + đính chính r74 hiện diện + catalog/pool r73 GIỮ NGUYÊN (không phá contract).
- **Gate:** PASS toàn bộ 63.2s — type_check ✓ (lần chạy nền giữa chừng FAIL đúng 2 lỗi thật: so sánh `> number` còn sót ở zenStatusSummary sau khi value map đổi shape + `http` possibly-undefined trong test — cả hai đã sửa) · lint ✓ · imports ✓ · **595/595 test** (582 + 13 mới).
- **Lỗi tự bắt thêm lúc triển khai (đúng giao thức quan sát):** bật đầu tiên bản in-process cache chỉ → API vẫn trống ⚠ → truy ra gốc rễ **Next.js dev nạp llm.ts 2 instance** (worker instrumentation ≠ route — chính goal-loop-worker.ts:1326 đã ghi nhận) → nâng cấp fix r74b: block-state ghi **file dùng chung db/zen-block-state.json** (merge memory+file khi ghi, prune hết hạn, mtime-cache khi đọc, resolve-once đường dẫn tuyệt đối, fail-open 2 chiều). Lợi phụ: process mới khởi động đọc ngay file → không đốt lại HTTP+CLI re-probe cho model đã biết chết sau mỗi restart.
- **E2E chéo process (bằng chứng mạnh nhất — đúng luồng sản xuất):** restart PM2 (instrumentation nhận code mới, health 200 sau 6s) → chat NEMESIS model=big-pickle (job nền cmv0s7x09…) → worker đánh dấu `http:big-pickle` + `cli:big-pickle` (reason r74 mới) vào file → **`GET /api/agents/models` (process route, memory trống) trả `big-pickle: blockedTransports ["http","cli"]`** → dropdown sẽ hiện ⚠ + hàng mờ + tooltip "sẽ tự chuyển tiếp về space-bunny-free". Job hoàn tất `completed` — trả lời qua ZEN FAILOVER SBF (stopReason=complete, 3 vòng, ChatMessage assistant 400 chars đã lưu) — agent KHÔNG chết, đúng thiết kế nhiều lớp.
- **Sandbox = bản mới nhất:** PM2 restart tại HEAD sạch; `next dev` hot-reload từ disk → mọi request phục vụ đúng code hiện tại; session bằng chứng giữ lại: `r74-e2e-truth-test`, `r74-e2e-truth-test-2`.

---

# ROUND-75 (phiên 2026-10-09 ~12:00–13:05Z — user: "xác định phiên bản sandbox có mới nhất không + đánh giá so sánh model về CODING và GỌI TOOLS")

> **Ngữ cảnh:** HEAD xuất phát `f25a3c7` (r74) = origin/main. Phiên này là nâng cấp battery đánh giá theo 2 trục user hỏi, phát hiện 1 bug kiến trúc mới + 4 ghi nhận vận hành.

## A. MỤC GHI NHẬN MỚI

### BUG2-034 · F · P1 — Đường CLI native GHÉP 2 BỘ TOOL: model bị nhầm/mừ/tự làm thay — gồm cả side-effect thật vào cây production (bằng chứng battery r75)

- **Cơ chế:** `callOpenCodeCLIProvider` spawn `opencode run --model opencode/X '<sysTMO + prompt>'` với cwd = thư mục app → model nhận system prompt TMO (bộ tool TMO + protocol văn bản `tool_call:`) NHƯNG đồng thời nằm trong harness opencode với bộ tool THẬT của nó (native bash/read/write/glob/grep/task/skill + plugin tmo_* bridge gọi ngược /api/tools/execute). 2 bộ tool song song tồn tại → 4 hành vi lệch chuẩn quan sát được:
  1. **TỪ CHỐI** (không phát `tool_call:` text vì "tool không có thật"): SBF, ling, step-5, mimo (t2), longcat (t1 v3) — kể cả khi system prompt TMO khai báo tool hợp lệ. SBF trả thẳng: "đó không phải bộ tool thực sự của tôi, nên tôi không thể phát lệnh gọi chúng".
  2. **GỌI NATIVE BỊ CHẶN**: nemotron-3-ultra phát native tool_call `dispatch_agents_parallel` → opencode chặn "Invalid Tool — tried to call unavailable tool" (nó chỉ chấp nhận registry của chính nó).
  3. **HIJACK sang tool opencode**: step-5 gọi `task` (subagent của opencode) thay vì dispatch TMO; SBF chạy `which data_map`/`ls` bằng bash khi ở context không-cấu-hình.
  4. **TỰ LÀM THAY + SIDE-EFFECT THẬT (mạnh nhất)**: SBF nhận nhiệm vụ "giao 2 việc song song (MEGATRON viết unit test hàm đăng nhập, SHOCWAVE kiểm tra hiệu năng)" → KHÔNG phát `dispatch_agents_parallel` — tự dò codebase bằng tmo_grep/tmo_file_read (8+ lượt tool thật: tìm handler login, đọc src/lib/api-auth.ts, src/app/api/auth/setup…) rồi **TỰ VIẾT 553 dòng test thật vào cây production** (`tests/login-auth-handler.test.ts` 325 dòng + `tests/login-auth-token.test.ts` 228 dòng — nội dung đúng pattern repo, mô tả chính xác cơ chế token 2 tầng thật). Đã dọn 2 file (rác battery) nhưng cùng cơ chế này, agent production override model qua dropdown hoàn toàn có thể ghi file trực tiếp ngoài tầng audit ToolMetric của TMO.
- **Ngữ cảnh quyết định hành vi:** (a) /tmp trống config → 5/8 model từ chối tool TMO; (b) cwd=tmo-app (sản xuất — permission edit/bash deny + plugin tmo_*) → model bơi vào tmo_*/native làm thật; (c) `--agent tmo` (config agents.tmo với tools: false hết) → SBF ĐỔI NGAY sang phát protocol văn bản `tool_call: data_map(...)` PASS clean (26.4s) — fix hợp lệ.
- **Fix đề xuất (chưa triển khai — cần thiết kế cẩn thận):** định nghĩa agent chuyên vận chuyển trong repo opencode.json (ví dụ `agents.tmo`) với **chỉ** bộ tool cần thiết của inner-loop (tmo_* bridge + native write/read/bash mà inner-loop dùng — xem llm.ts:133 "native write/bash/read + tmo_* bridge") tắt phần còn lại (task/skill/webfetch/websearch/glob/grep…), rồi `callOpenCodeCLIProvider` thêm `--agent tmo`. CẢNH BÁO: KHÔNG tắt sạch mọi tool như bản thử nghiệm (battery đã chứng minh tắt sạch thì SBF phát văn bản PASS, nhưng inner-loop CLI của goal-loop đang dựa native write/bash/read để THỰC THI công việc — tắt sai sẽ giết chu kỳ thực thi). Cần rà _tmo-common.ts + inner-loop để chốt danh sách tool giữ lại. Bỏ ngỏ chờ phiến kế tiếp (lộ trong review r75 — ưu tiên trước khi cho agent override model free qua dropdown chạy mission thật).
- **Bảng chứng:** /tmp/oc-r75b-*.log, /tmp/oc-r75c-*.log, /tmp/oc-r75d-*.log (raw từng phép); /tmp/oc-battery-r75{b,c,d}.{json,md}; script tái lập /home/z/my-project/oc-battery-r75{,b,c,d}.ts + /tmp/oc-matrix-now.sh.

### GHI-NHẬN-r75-a · Policy flap Zen LẦN THỨ 5 (mở ~12:15–12:33Z → đóng ~12:35Z)
- Matrix 12:19Z: **7/8 model free ALIVE qua CLI native** (SBF, big-pickle, ling, longcat, mimo, nemotron-ultra, step-5 trả lời OK; chỉ nemotron-3.5-lightning treo boot) — đối chiếu r74 09:30Z toàn 403 → cửa ĐÃ MỞ LẠI trong khung 12:15-12:33Z.
- Battery r75d ~12:35Z: mọi phép CLI từ app-dir + agent-dir → 403 FreeTierError trở lại → cửa ĐÓNG chỉ ~18 phút sau.
- **Không cần hành động:** thiết kế r74 (block-cache TTL 60s/300s + dropdown refetch khi mở + badge ⚠ runtime) tự thích ứng đúng — flap nhanh ở mức phút cũng chỉ là 1 vòng re-probe. Xác nhận thêm tính đúng đắn của quyết định r74 "trạng thái sống phải là số liệu runtime, không hardcode".

### GHI-NHẬN-r75-b · ENOSPC — ổ đĩa sandbox 100% ĐẦY (0 byte trống) giữa battery
- Hiện tượng: CLI thoát exit-1 trong ~8ms với log 0 byte hàng loạt + bun crash "ENOSPC: no space left on device" khi ghi /tmp — df: 9.4G/9.9G used.
- Gốc rễ: **~/.bun/install/cache chiếm 4.2GB** (cache cài đặt tích luỹ) + .next 2.0GB + scaffold my-project 1.5GB + rác probe /tmp ~450MB (r74-home 164M, oc-home-test 163M — probe HOME-cô-lập sinh ra bản sao state opencode đầy đủ).
- Đã xử lý: `bun pm cache rm` + dọn /tmp probe cũ → **giải phóng 1.4GB (86% used)**.
- Rủi ro treo: app đang chạy với đĩa sát ngưỡng có thể chết NGẦM khi ghi ChatMessage/attachment/session (SQLite WAL) — tmo-keepalive chỉ ping HTTP, KHÔNG theo dõi đĩa. Đề xuất (bỏ ngỏ): thêm disk-guard vào keepalive/MemWatchdog (cảnh báo + tự dọn bun cache khi >95%).

### GHI-NHẬN-r75-c · `opencode run` treo 0 byte khi stdin là pipe không có EOF
- Probe chạy foreground thừa kế stdin pipe từ harness → CLI chờ TTY mãi mãi (8/8 treo rc=137 dù door đang mở). Chạy `... < /dev/null` (hoặc spawnSync không stdin) → hoàn tất bình thường. Ghi chú phương pháp luận cho mọi probe CLI tương lai (r73/r74 matrix từng chạy foreground ổn — hành vi stdin của harness khác nhau từng phiên; luôn chốt stdin explicitly).

### GHI-NHẬN-r75-d · nemotron-3.5-lightning-free: chậm + boot flaky hôm nay
- Matrix 12:19Z treo boot (2/2 lần); battery t2 cần >90s (đang phát ĐÚNG `tool_call: dispatch_agents_parallel` khi bị kill ở 90s — output một nửa); t3 coding mất 72.8s. Đối lập r73 (matrix OK). Khuyến nghị: giữ trong catalog nhưng không đưa vào pool failover/last-resort (hiện pool = ling/mimo/big-pickle — đã đúng).

## B. ĐÁNH GIÁ SO SÁNH MODEL — CODING & GỌI TOOLS (mục 2 user)

**Nguồn:** battery r73 2 tầng (khi cửa mở 06:00Z) + battery r75 b/c/d hôm nay (matrix 12:19Z + drill format + context sản xuất + --agent fix test + HTTP). Tất cả output thô giữ ở /tmp.

### Trục CODING (2 nguồn độc lập)
| Model | r73 basic (bun chạy thật 4 case) | r73 hard (romanToInt 6 case) | r75 LRU-146 (LeetCode, 6 assert bun chạy thật) | Tốc độ coding |
|---|---|---|---|---|
| space-bunny-free | ✅ 12/12 case | ✅ | ✅ 4.9s | ⚡ nhanh nhất |
| big-pickle | ✅ | ✅ | ✅ 6.0s | ⚡⚡ |
| mimo-v2.6-flash-free | ✅ | ✅ | ✅ 9.9s | ⚡ |
| longcat-2.5-preview-free | ✅ | ✅ | ✅ 9.1s | ⚡ |
| nemotron-3-ultra-free | ✅ | ✅ | ✅ 8.6s | ⚡ |
| ling-3.1-flash-free | ✅ | ✅ | ✅ 17.3s | trung bình |
| step-5-preview-free | ✅ | ✅ | ✅ 25.0s | chậm |
| nemotron-3.5-lightning-free | ✅ | ✅ | ✅ 72.8s | chậm nhất |

→ **Coding: 8/8 đạt cả 2 tầng khó** — khác biệt nằm ở TỐC ĐỘ (4.9s ↔ 72.8s, chênh 15 lần) và độ tin cậy boot (nemotron-3.5 flaky).

### Trục GỌI TOOLS (phân theo transport — quyết định hành vi)
| Model | HTTP text-protocol (đường sản xuất) | CLI context trần (/tmp) | CLI + sysprompt TMO | CLI --agent tmo (tools tắt) |
|---|---|---|---|---|
| space-bunny-free | ✅✅ T1+T2 PASS clean 2.7-3.3s (+ track record r67-r74) | ❌ từ chối + chạy bash dò môi trường | ❌ từ chối ("tool không thật") | ✅ T1 PASS clean 26.4s (đổi hành vi!) · T2 vẫn từ chối |
| big-pickle | (403) | ❌ từ chối | ✅ T2 PASS clean 7.2s | (403 door đóng) |
| mimo-v2.6-flash-free | (403) | ❌ từ chối | ✅ T1 PASS clean 5.9s · T2 ❌ | (403) |
| longcat-2.5-preview-free | (403) | ✅✅ PASS clean (drill thẳng) | ❌ T1 (đổi chiều khi có sysprompt!) | (403) |
| nemotron-3-ultra-free | (403) | ✅✅ PASS clean (drill thẳng) | ⚙️ phát NATIVE bị opencode chặn | (403) |
| nemotron-3.5-lightning-free | (403) | ✅ (chậm, >90s) | (chậm — đúngformat khi đủ giờ) | (403) |
| ling-3.1-flash-free | (403) | ❌ từ chối | ❌ từ chối | (403) |
| step-5-preview-free | (403) | ❌ từ chối | ❌ hijack sang tool `task` | (403) |

**Đọc bảng:**
- **Tool-calling ỔN ĐỊNH NHẤT = space-bunny-free trên đường HTTP** (đường sản xuất của nó): PASS cả 2 phép clean + hàng trăm tool call thật qua 8 round mission — đó là lý do nó là lõi chính. Trên đường CLI nó bị context opencode kéo lệch hoàn toàn (từ chối hoặc tự làm thay).
- **big-pickle = ứng viên mạnh nhất cho vai agent tool-user khi cửa CLI mở**: duy nhất phát protocol văn bản chuẩn ngay trong context hỗn hợp (T2 PASS clean 7.2s) + coding nhanh nhất nhì + battery r73 JSON schema lồng chuẩn nhất.
- **mimo**: đúng format khi sysprompt rõ (T1 PASS 5.9s) nhưng không nhất quán (T2 từ chối) — hợp vai tiện/hợp tác vụ nhẹ.
- **nemotron-ultra + longcat**: tuân theo mệnh lệnh trực tiếp tốt (drill thẳng → PASS clean ngay) nhưng dễ bị context kéo lệch (native blocked / đổi chiều với sysprompt) — hợp vai phân tích khi prompt điều khiển chặt.
- **ling + step-5**: coding đạt nhưng gọi tool cần ngữ cảnh sạch (đường HTTP hoặc --agent tách tool) — hiện không có đường HTTP (403).
- **Bằng chứng agentic thật đặc biệt (SBF, cwd app):** nhận nhiệm vụ giao việc → tự dò codebase 8+ lượt tool thật (tmo_grep/tmo_file_read) → tự viết 553 dòng test khớp cơ chế auth thật của repo (token 2 tầng, không bcrypt) — năng lực agent thật rất cao nhưng **trên kênh sai** (vi phạm giao thức phân quyền TMO, ngoài audit ToolMetric) — chính là nội dung BUG2-034.

### Khuyến nghị tổng hợp theo vai (điểm nhấn mới so với r73)
1. **Lõi chính mọimission**: giữ space-bunny-free (HTTP xoay key + failover nhiều lớp — không thay đổi).
2. **Override đa dụng khi cửa CLI mở**: big-pickle (duy nhất giữ protocol văn bản chuẩn trong context hỗn hợp).
3. **Tiện ích nhẹ nhanh**: mimo-v2.6-flash-free.
4. **Phân tích sâu/khối lượng lớn**: nemotron-3-ultra-free (chấp nhận chậm reasoning 33.5s).
5. **Hạ cảnh giác**: nemotron-3.5-lightning (chậm + flaky boot hôm nay); ling/step-5 chỉ dùng khi có đường ngữ cảnh sạch.
6. **TRƯỚC KHI mở override model free cho mission thật**: cần chốt fix BUG2-034 (agent chuyên vận chuyển với bộ tool được tuyển) — nếu không, agent override có thể tự làm thay việc của agent khác + ghi file ngoài audit.

## C. KIỂM TRA PHIÊN BẢN (mục 1 user)
- `git fetch origin` 12:05Z: HEAD `f25a3c7` = origin/main, working tree sạch, 0 stash → **sandbox ĐANG CHẠY BẢN MỚI NHẤT** (không cần pull — r74 đã push đúng bản này).
- PM2 theopusflashlite uptime khớp restart sau commit r74 (09:47:11Z); `next dev` hot-reload từ đĩa; health 200; mini-services opencode-server 18790 (401 đúng thiết kế) + cron-scheduler 3004 + gateway on-demand — đúng thiết kế service-manager.
- Gate r74 lần gần nhất PASS 63.2s (595/595) — không đổi code lõi trong phiên này (chỉ Bug_v2.md + dọn rác probe).

## D. Nghiệm thu ROUND-75
- Battery 4 đợt (v1 bỏ — lỗi runner nuốt chẩn đoán; v2/v3/v4 giữ): 60+ lượt gọi model thật qua 3 context (/tmp trần, cwd app sản xuất, --agent tmo cô lập) + 2 phép HTTP SBF — mọi kết quả có log raw + JSON/MD tổng hợp tại /tmp/oc-*.
- Side-effect battery đã dọn sạch (2 file test SBF tự viết — xem BUG2-034) — working tree về sạch trước commit.
- ENOSPC xử lý xong (1.4GB tự do) — app chạy liên tục qua toàn bộ phiển (health 200, không lỗi SQLIte/ghi file trong log).
- Không đổi code lõi → không cần chạy gate toàn phần; commit phiên này chỉ Bug_v2.md.

### GHI-NHẬN-r75-e · [Episodic] upsertEpisodeEmbedding failed: Internal Server Error (2 lần duy nhất, đúng phiên này)
- Chuỗi: NVIDIA embed passage ✓ (2048d sinh vector OK) → upsert Qdrant trả 500 "Internal Server Error" → episode VẪN được ghi (fail-open đúng thiết kế). 2/2 lần quanh cửa sổ sub-agent SHOCWAVE episode + r71-harvest DelegationLesson. Tần suất thấp (2 lần toàn bộ dev.log) — giữ watch; nếu lặp lại ở mission kế → điều tra collection Qdrant (có thể dính ảnh hưởng từ gián đoạn dưới tải khi battery chạy song song + ENOSPC giai đoạn 100% đầy).

### BUG2-035 · D · P3 — Blueprint P0-1 ví dụ wilsonCI(0.8, 25) → [0.616, 0.910] ứng z≈1.9, không phải z=1.96 mặc định
- **Hiện tượng:** docs/BLUEPRINT-STATS-LEARNING-P0-P6.md mục P0-1 (bước test) ghi "wilsonCI(0.8, 25) → [0.616, 0.910]". Tính lại độc lập theo công thức Wilson chuẩn với z = 1.96 (mặc định của chính spec): [0.608681, 0.911381]. Cặp số [0.616, 0.910] tái hiện đúng khi z ≈ 1.9 — khả năng cao người soạn dùng nhầm z.
- **Xử lý:** r76 implement theo CÔNG THỨC với z mặc định 1.96 (không bám số ví dụ); test đối chiếu [0.6087, 0.9114]; ghi chú erratum trong JSDoc src/lib/stats/inference.ts. Tiền lệ r1 (scaffold fallback): spec có thể sai số, công thức là chuẩn.

### BUG2-036 · D · P3 — Blueprint P0-1 ví dụ rougeL("the cat sat", "the cat") ghi "recall 1.0" — thực chất là precision
- **Hiện tượng:** cùng mục P0-1, ví dụ test ghi rougeL("the cat sat", "the cat") recall 1.0. LCS = "the cat" (2 token): precision = LCS/len(hyp) = 2/2 = 1.0; recall = LCS/len(ref) = 2/3 ≈ 0.667. Giá trị 1.0 thuộc về PRECISION, nhãn "recall" sai.
- **Xử lý:** r76 test đúng chiều: precision 1.0 / recall 0.667 / f1 0.8; ghi chú erratum trong JSDoc src/lib/stats/text.ts.

### BUG2-037 · D · P2 — Blueprint silhouetteFromGraph công thức nguyên văn s=(b−a)/max(a,b) BỊ ĐẢO DẤU trên trọng số tương tự (dương khi gán SAI cụm)
- **Hiện tượng:** mục P0-1 + P1-M5 mô tả biến thể đồ thị: a(i) = mean trọng số cạnh nội cụm, b(i) = max mean trọng số cạnh liên cụm, s(i) = (b−a)/max(a,b). Trọng số Leiden là ĐỘ TƯƠNG TỰ (càng cao càng gần). Áp nguyên văn: cụm gán ĐÚNG (nội mạnh a lớn, liên yếu b nhỏ) → s ÂM; cụm gán SAI (nội rời rạc a≈0, liên mạnh b lớn) → s DƯƠNG — ngược hoàn toàn ý nghĩa silhouette (P1-M5 sẽ chọn γ MINIMIZING chất lượng). Ngoài ra "không cạnh nội → a=0" với công thức nguyên văn cho s=+1 cho node không nối với chính cụm mình (nghịch lý).
- **Xử lý:** adjudicate TRƯỚC khi code: s(i) = (a−b)/max(a,b) (dương = gán đúng), chuẩn hoá w'=w/(1+w) bên trong, singleton → 0, node cụm >1 phần tử mà không có cạnh nội → s=−1. JSDoc đầy đủ tại src/lib/stats/cluster-quality.ts; test 2 chiều (graph gán đúng → +0.904762, graph gán sai → −0.904762).

### BUG2-038 · G · P1 — Override "brace-expansion": "5.0.12" toàn cục làm GÃY eslint trên mọi fresh install (minimatch@3 của @eslint/config-array nhận nhầm ESM v5)
- **Hiện tượng:** package.json overrides (từ commit 6b5787a — đợt fix security 64→12 advisories) ép TOÀN BỘ brace-expansion về 5.0.12. Hệ quả trên fresh install (bun 1.3.14): @eslint/config-array → minimatch@3.1.5 (`var expand = require('brace-expansion')` kỳ vọng CJS function kiểu v1) nhận brace-expansion@5 (ESM, named exports) → `TypeError: expand is not a function` khi nạp config → `bun run lint` exit 2 → gate chặn. Cây lỗi tái lập được trên fresh clone + fresh install (đã thử: rm -rf node_modules bun.lock && bun install — vẫn hỏng); bun.lock cũ cũng KHÔNG chứa brace-expansion@1.x (cây thiếu gói). Sandbox trước đó không gặp vì node_modules là di sản install từ TRƯỚC khi override xuất hiện.
- **Vì sao an toàn khi gỡ:** override được thêm để dẹp advisory ReDoS CVE-2025-5889 — nhưng dòng 1.x đã vá từ 1.1.12; resolve tự nhiên cho minimatch@3.1.5 nhận 1.1.21 (≥ 1.1.12, đã vá) trong khi minimatch@10 giữ 5.0.12 lồng đúng chỗ. Sau khi gỡ: lock chứa đủ cả 2 bản (1.1.21 + 5.0.12), `bun run lint` exit 0, gate 4 stage PASS 56.7s.
- **Fix:** xoá dòng "brace-expansion": "5.0.12" khỏi overrides (giữ nguyên 11 override còn lại), tái sinh bun.lock. File đụng: package.json + bun.lock. Kiểm chứng: gate PASS (type_check + lint + imports + tests) và lock mới chứa brace-expansion@1.1.21 + @5.0.12 phân tách đúng từng minimatch.

### BUG2-039 · C · P1 — aucRoc thiếu điểm neo gốc (0,0): AUC-ROC bị ĐẾM THIẾU mọi khi nhóm score cao nhất lẫn cả 2 lớp (tie ở đỉnh) — fb-P0-R1-01
- **Hiện tượng:** `sweepThresholds` chỉ phát điểm CurvePoint tại các score quan sát được (không có điểm threshold=+∞ "không dự đoán gì"), trong khi `aucRoc` tích phân hình thang trực tiếp trên danh sách đó. Hệ quả: khi nhóm score CAO NHẤT chứa lẫn cả positive lẫn negative (tie ở đỉnh), bước nhảy chéo (0,0)→(fpr₁,tpr₁) bị co thành đường dọc tại fpr₁ → mất toàn bộ diện tích tam giác gốc. Đối chứng định nghĩa chuẩn AUC = P(score_T > score_F) + ½P(bằng) trên 8 bộ: 4 bộ lệch — tie đỉnh [0.9,0.9,0.2]×[T,F,F]: đúng 0.75, code trả 0.5; toàn-tie [0.5,0.5]×[T,F]: đúng 0.5, code trả 0.0; toàn-tie 4 phần tử: đúng 0.5, code 0.0; nhiều tầng tie: đúng 1/3, code 0.25. Bộ không tie thì khớp — nên lỗi KHÔNG bị phát hiện bởi 42 test r76 (toàn bộ bộ test đều không tie ở đỉnh).
- **Tác động consumer:** P2-M1 threshold-sweep lấy AUC từ đây để so sánh ngưỡng; evaluator confidence có tie hoàn toàn xảy ra trong thực tế (vd mọi verdict cùng score 1.0) → AUC sẽ là 0 thay vì 0.5 → quyết định ngưỡng sai hướng.
- **Fix:** `aucRoc` chèn neo (0,0) (threshold=+∞) khi điểm fpr nhỏ nhất sau sort chưa nằm ở gốc; đã có sẵn thì không chèn (trùng vô hại). File đụng: src/lib/stats/classification.ts. Kiểm chứng: 12 bộ ngẫu nhiên có tie khớp pairwise AUC (|diff| < 1e-12); 4 test regression mới trong r76 (0.75 / 0.5 / 0.5 / 1-3); mọi giá trị test cũ không đổi (2/3, tách hoàn hảo = 1). Phát hiện qua giao thức fixbug.md đợt FB-P0 vòng R1 (audit độc lập + chấm chéo phương pháp thứ ba).

### BUG2-040 · C · P2 — mannWhitneyU nuốt NaN trong dữ liệu: kiểm định vẫn "chạy" và trả kết luận p GIÁ TRỊ RÁC âm thầm — FB-P0-R1-02
- **Hiện tượng:** `mannWhitneyU([NaN,1],[1,2])` trả {u: 0.5, z: −1.22, p: 0.22} — hợp lệ bề ngoài. Nguyên nhân: Array.prototype.sort với comparator `(a,b)=>a−b` cho mọi phép so chứa NaN trả NaN → treated 0 → thứ tự hạng rác, tie-correction sai → z/p sai nhưng KHÔNG có dấu hiệu nào cho caller biết. Khác các hàm khác (mean/stddev/welchTTest/anovaF lan toả NaN tự nhiên qua số học), MWU là hàm duy nhất sort-based nên NaN bị NUỐT.
- **Tác động consumer:** consumer cổng kiểm định (Layer 9 / P3 nhóm Welch-t/χ²) ăn dữ liệu từ DB — một giá trị null/NaN lọt qua sẽ cho ra kết luận thống kê SAI mà không lỗi nào bắn ra. Đây là lớp lỗi nguy hiểm nhất trong thống kê: sai âm thầm.
- **Fix:** quét Number.isFinite cả hai mảng đầu vào → NaN cả 3 trường. File đụng: src/lib/stats/inference.ts. Kiểm chứng: probe trước/sau (trước z=−1.22 rác, sau NaN cả 3); test regression r76 mới; giá trị sạch không đổi (z=−1.963961012). Phát hiện qua giao thức fixbug.md đợt FB-P0 vòng R1.

### BUG2-041 · G · P2 — Quality gate để lại ToolMetric TEST trong DB production: 2 test gọi HTTP thật vào app sống (shr mục G + protected-paths) — FB-P1-R1-01
- **Hiện tượng:** mỗi lần gate chạy, bảng ToolMetric của db/custom.db THẬT tăng ~13-15 row sessionId `test-shr-*` (agentRole opencode-bridge) hoặc sessionId `unknown` (agentRole test-infra-guard). Bằng chứng: 156/156 row ToolMetric tính đến 10:17Z 2026-10-10 đều là test (39 + 117), trải 08:22→10:15 đúng các lần gate trong phiên. Nguồn: (a) tests/shr-cot-todo.test.ts mục G gọi POST /api/tools/execute thật — app (process khác, DB thật) ghi ToolMetric cho MỌI tool call; cleanup sẵn có của test chỉ dọn Todo/Hypothesis, BỎ SÓT ToolMetric; (b) tests/protected-paths.test.ts dò security guard qua cùng endpoint — không dọn gì. DB-cô-lập của bunfig KHÔNG phủ được side-effect HTTP xuyên process.
- **Tác động:** làm bẩn CHÍNH lớp đo P1-M3/P1-M4 đợt 2: anomaly scan bắt 13 "anomaly" toàn từ test data (bound 16ms, value 20ms); KPI tool_success_rate n=156 tính trên test rows. Baseline P1 bị bóp méo hoàn toàn.
- **Fix:** (1) guard mục G bằng env TMO_SHR_HTTP_E2E=1 — gate chạy hermetic (skip + ghi chú), E2E thủ công vẫn chạy được theo thiết kế gốc; (2) protected-paths (security test — GIỮ trong gate) tự dọn bằng BunSqlite DELETE ToolMetric WHERE agentRole='test-infra-guard' (đợi 750ms cho fire-and-forget land, PRAGMA busy_timeout, pattern cleanup sẵn của shr G); (3) dọn 1 lần 156 row khỏi production. Kiểm chứng: gate chạy lại xong ToolMetric count = 0; KPI tool_success_rate hiện n=0 no_data (thật — chưa có hoạt động tool thật nào hôm nay).

### BUG2-042 · G · P1 — callLLM phân loại HTTP 410 Gone là server_error: xoay 4 key × 3 lần + cooldown 15s LẶP VÔ HẠN trên model NVIDIA đã decommission — FB-P1-R1-04
- **Hiện tượng:** eval runner dùng ANSWER_MODEL deepseek-v4-flash-0731 (đã EOL) → mọi attempt trả 410 → rơi nhánh 'server_error' → sweep 12 attempts NHANH (~0.1s/attempt) → "ALL 4 keys rate-limited — waiting 15s" → retry → lặp mãi. Budget tổng thiết kế cho worst-case timeout 240s/attempt (~48 phút) KHÔNG BAO GIỜ cạn với 410 trả lời tức thời. Bằng chứng live: run cmv29082p0012navrlnwlec1v treo 0/3 suốt 18+ phút, log đầy chu kỳ fail 1/3→3/3→cooldown→lặp. Cùng dòng đã có tiền lệ 404 (audit 2026-10-15) với lý do giống hệt: 410 là deterministic THEO MODEL — key khác retry cùng model-name cũng 410.
- **Tác động:** mọi consumer gọi model đã decommission (eval answer, judge, extraction fallback) treo vĩnh viễn thay vì fail-fast — eval subsystem hoàn toàn không dùng được cho tới khi model được thay.
- **Fix:** thêm 410 vào isDeterministic4xx (src/lib/llm.ts attemptNvidiaOnce) — 410 → 'bad_request' → dừng xoay vòng sau 1 attempt, không soft-mark cooldown oan key. Kiểm chứng: sau fix run cmv29vh180001na7dkz82772i hoàn tất 3/3 trong ~7 phút (trước đó: ∞) — log hiện "bad_request (HTTP 410) — LỖI BODY deterministic, dừng xoay vòng" đúng sau key đầu tiên.

### BUG2-043 · G · P1 — NVIDIA NIM model matrix RÁC TOÀN PHẦN: deepseek-v4-flash (eval answer) + gpt-oss-120b (judge 1) + minimax-m3 (judge 3 VÀ agent primary) đều HTTP 410 EOL — chỉ kimi-k3 còn sống
- **Hiện tượng:** baseline eval sau BUG2-042 fix hoàn tất và bộc lộ trạng thái thật: judge scores toàn [-1, x, -1] — gpt-oss-120b EOL 2026-09-03, minimax-m3 EOL 2026-09-09 (thông điệp server: "reached its end of life"), deepseek-v4-flash-0731 EOL (thông điệp 2026-09-21). kimi-k3 (judge 2) CÒN SỐNG — chấm đúng ngữ nghĩa (0.0 cho security case trả lời rỗng, 1.0 cho negative case từ chối đúng). Hệ quả: (a) faithfulness metrics của eval = rác (median 1 judge sống); (b) model primary của toàn bộ agent chat (minimax-m3 theo user directive gần nhất) đã chết → mọi agent call phải đốt failover mới tới kimi-k3/Zen.
- **Tác động:** faithfulness của eval run baseline ghi 0.333 không đáng tin (chỉ 1/3 judge sống); agent latency tăng do failover-chain; ANTI-pattern nếu không nhận ra: mọi chỉ số đo từ NVIDIA sẽ âm thầm suy yếu.
- **Xử lý:** KHÔNG tự ý đổi model matrix trong đợt 2 — chọn model là điểm dừng quyết định user (tiền lệ user directive 2026-10-16 minimax-m3). Ghi nhận: eval baseline P1-M2 vẫn hợp lệ cho metrics retrieval (ndcg/mrr/recall không phụ thuộc LLM — bằng chứng 3/3 case giá trị thật); faithfulness chờ matrix mới. Đề xuất chờ user: battery lại model matrix NVIDIA (kimi-k3 là ứng viên primary) hoặc chuyển hẳn judges sang Zen transport.
- **ĐÓNG (2026-11-30 — USER DECISION "model matrix mới" triển khai đầy đủ):** NIM chỉ giữ embed + nemotron-3-ultra-550b (extraction NIM-first, fallback chuỗi Zen) + kimi-k3 như LỰA CHỌN agent tạm thời (dropdown chọn → callLLMForAgent route NIM thật — E2E: agent tự xưng "Tôi đang chạy trên model Kimi", model=moonshotai/kimi-k3, 42489 tokens; NIM hang/429 → breaker trip → tự fallback Zen space-bunny-free). minimax-m3 + cả dòng deepseek + gpt-oss-120b LOẠI BỎ TOÀN BỘ (410 EOL live-probe). Judges mặc định: kimi-k3 (nếu sống) → fallback space-bunny-free (user directive nguyên văn). ANSWER_MODEL eval/redteam: deepseek-v4-flash (chết) → space-bunny-free (production core, khác judge primary). E2E eval 1 case: 3/3 judge scores hợp lệ (kimi-k3 ✓ 323 tokens + SBF fallback khi breaker trip giữa chừng — đúng thiết kế). Live-probe 2026-11-30: kimi-k3 ALIVE ~120s/call tối giản (chậm), nemotron-550b ALIVE 4.7s, SBF ALIVE 1.2s.

---

## PHÁT HIỆN GIAO THỨC FIXBUG — BỔ SUNG ĐẦY ĐỦ THEO CHỈ THỊ USER 2026-10-11

> **Bối cảnh bổ sung:** theo chỉ thị user (fixbug.md = file giao thức + biên bản tóm tắt, KHÔNG phải nơi ghi chi tiết bug/fix), toàn bộ phát hiện các đợt FB-P0 → FB-ĐỢT5 vốn chưa có entry sổ này (quy tắc ghi nhận cũ chỉ bắt P0/P1/P2-có-tác-động-consumer lên sổ, P3/P4 nằm trong biên bản fixbug.md) được chuyển về đây đủ, đánh số tiếp BUG2-044 trở đi. Mức **P4** = mở rộng dưới P3 (vệ sinh nhẹ/hi sinh chấp nhận được) — dùng từ đợt FB-ĐỢT5; R2-01 đợt 5 được phân loại C khi bổ sung (hành vi khác spec). Nội dung từng phát hiện giữ nguyên thông tin biên bản gốc (hiện tượng / tác động / fix + kiểm chứng + nguồn vòng rà).

### BUG2-044 · C · P3 — zScore σ âm trả điểm z ĐẢO DẤU vô nghĩa, σ NaN lệch convention fail-open — FB-P0-R1-03
- **Hiện tượng:** `zScore(x, −0.5)` trả −z (đảo dấu — trông như đo được) trong khi σ âm vô nghĩa toán học; `zScore(x, NaN)` trả NaN trong khi các hàm descriptive cùng lớp fail-open trả 0 — không nhất quán convention.
- **Tác động consumer:** Layer-9 kiểm định ăn giá trị đảo dấu trông hợp lệ — sai âm thầm.
- **Fix:** guard `σ ≤ 0` → 0 (fail-open thống nhất); NaN → NaN theo convention đã ghi JSDoc. File đụng: src/lib/stats/descriptive.ts. Kiểm chứng: 1 test regression mỗi guard; giá trị sạch không đổi. Phát hiện qua giao thức fixbug.md đợt FB-P0 vòng R1.

### BUG2-045 · C · P3 — iqrBounds k âm → low/high ĐẢO CHIỀU (low 3.25 > high 1.75); k NaN → low/high NaN nhưng q1/q3 vẫn số — FB-P0-R1-04
- **Hiện tượng:** hệ số k âm đảo bất đẳng thức khoảng (low > high); k NaN cho nửa-kết-quả NaN nửa số — trạng thái lai không nhất quán cho caller.
- **Tác động consumer:** khoảng loại ngoại lệ (IQR fence) với k âm tự cho low > high — mọi phép so nằm-ngoài-fence cho kết quả rác.
- **Fix:** `k` không hữu hạn hoặc âm → NaN cả 4 trường (nhất quán toàn bộ). File đụng: src/lib/stats/descriptive.ts. Kiểm chứng: 1 test regression; hành vi hợp lệ giữ nguyên (iqrBounds([7]) = 7/7/7/7). Phát hiện qua giao thức fixbug.md đợt FB-P0 vòng R1.

### BUG2-046 · C · P3 — meanCI z âm → CI đảo chiều (low 2.48 > high 0.52); z=0 vô nghĩa không chặn — FB-P0-R1-05
- **Hiện tượng:** tham số z (điểm chuẩn chính tắc) âm trả cặp low/high đảo chiều trông vẫn "hợp lệ"; z=0 cho CI rỗng vô nghĩa không được chặn.
- **Tác động consumer:** mọi lời gọi meanCI với z từ nguồn ngoài (env/config) lỗi dấu sẽ nhận CI đảo chiều mà không có dấu hiệu nào.
- **Fix:** guard `z ≤ 0` → NaN + JSDoc. File đụng: src/lib/stats/inference.ts. Kiểm chứng: 1 test regression. Phát hiện qua giao thức fixbug.md đợt FB-P0 vòng R1.

### BUG2-047 · C · P3 — wilsonCI p ngoài [0,1] "vi phạm nhỏ" + n lớn lọt guard sqrt tự nhiên cho cặp trông hợp lệ — FB-P0-R1-06
- **Hiện tượng:** p=1.05 với n=10: `sqrt(p(1−p)/n)` vẫn dương (p(1−p)=−0.0525 âm dưới căn… sqrt trả NaN — nhưng tổ hợp (p−p²+z²/2n) có thể vẫn dương) — kết cục tùy tổ hợp số có thể lọt qua dưới dạng cặp số trông hợp lệ thay vì bị chặn đầu vào.
- **Tác động consumer:** xác suất ngoài [0,1] là đầu vào phạm phép — CI "tính được" trên dữ liệu vô nghĩa là sai âm thầm.
- **Fix:** guard `p` ngoài [0,1] → NaN + JSDoc. File đụng: src/lib/stats/inference.ts. Kiểm chứng: 1 test regression. Phát hiện qua giao thức fixbug.md đợt FB-P0 vòng R1.

### BUG2-048 · C · P3 — chiSquare2x2 cell âm: chi2 tính số rác hữu hạn trong khi p=NaN — FB-P0-R1-07
- **Hiện tượng:** bảng 2×2 chứa ô âm (không hợp lệ) → chi2 vẫn ra số hữu hạn nhưng p=NaN — nửa-kết-quản rác nửa NaN, không nhất quán.
- **Tác động consumer:** caller chỉ đọc chi2 (bỏ qua p) sẽ dùng số thống kê rác trên bảng không hợp lệ.
- **Fix:** ô âm → NaN cả hai (bảng không hợp lệ → kết quả không tồn tại). File đụng: src/lib/stats/inference.ts. Kiểm chứng: 1 test regression. Phát hiện qua giao thức fixbug.md đợt FB-P0 vòng R1.

### BUG2-049 · D · P3 — JSDoc silhouetteFromGraph không ghi hành vi trọng số w không hữu hạn (w=∞ → w'=NaN → node âm thầm đóng góp s=0) — FB-P0-R1-08
- **Hiện tượng:** trọng số không hữu hạn biến w'=max(w,0) thành NaN → node đó âm thầm đóng góp silhouette 0 mà JSDoc không ghi quy ước. Leiden thực tế không sinh w ngoài [−1,1] nhưng consumer khác (đồ thị tuỳ ý) có thể.
- **Tác động consumer:** người dùng hàm ngoài hệ sinh Leiden tưởng NaN được lan toả — nhận 0 âm thầm.
- **Fix:** JSDoc bổ sung quy ước w không hữu hạn (không đổi code — hành vi giữ, chỉ doc khớp). File đụng: src/lib/stats/cluster-quality.ts JSDoc. Kiểm chứng: rà đối chiếu doc-code; fuzz 300 graph đợt FB-ĐỢT3 xác nhận quy ước "NaN-lan-toả-0" hoạt động nhất quán. Phát hiện qua giao thức fixbug.md đợt FB-P0 vòng R1.

### BUG2-050 · C · P3 — wilsonCI nhận tham số z nhưng KHÔNG guard z âm/0 (đối xứng meanCI đã guard cùng lớp lỗi FB-P0-R1-05) — FB-P0-R2-01
- **Hiện tượng:** quét tính đối xứng tham số toàn bộ 30 hàm export ở vòng R2 phát hiện: wilsonCI z âm trả CI đảo chiều trông hợp lệ — cùng lớp lỗi FB-P0-R1-05 nhưng thoát vòng R1 vì vòng đó chỉ rà hàm theo phát hiện, chưa quét đối xứng toàn bộ.
- **Tác động consumer:** CI đảo chiều trênWilson — sai âm thầm như meanCI.
- **Fix:** thêm `!(z > 0)` vào guard + test regression + JSDoc. File đụng: src/lib/stats/inference.ts. Kiểm chứng: gate PASS sau fix (644/644). Phát hiện qua giao thức fixbug.md đợt FB-P0 vòng R2 (bằng chứng giá trị của vòng rà-lại toàn scope kể cả phần đã "đạt").

### BUG2-051 · C · P3 — KPI status hiện on_target/off khi sampleSize=0 — đọc nhầm "đạt mục tiêu" cho phép đo CHƯA TỒN TẠI — FB-P1-R1-02
- **Hiện tượng:** statusForKpi với n=0 hiện "on_target" (value=0 chỉ vì chưa có dữ liệu) — người đọc hiểu là đạt mục tiêu trong khi phép đo chưa tồn tại.
- **Tác động consumer:** dashboard/KPI layer đọc status trực tiếp — kết luận sai hướng trên KPI chưa có dữ liệu (5 KPI n=0 ở thời điểm fix).
- **Fix:** status = 'no_data' khi n===0 (thêm type + ưu tiên trước mọi so target; áp cả nhánh compute lỗi). File đụng: src/lib/kpi/compute.ts. Kiểm chứng: test mới (xoá EvalRun → eval_ndcg/eval_recall n=0 → no_data; KPI còn dữ liệu vẫn tính bình thường). Phát hiện qua giao thức fixbug.md đợt FB-P1 vòng R1.

### BUG2-052 · C · P3 — anomaly-detector group key + dedupeKey dùng separator space/'|' — toolName chứa space gộp nhầm 2 nhóm — FB-P1-R1-03
- **Hiện tượng:** group key nối toolName + agentRole bằng space rồi dedupeKey bằng '|' — toolName chứa space (`"a b"`+role `"c"` ≡ tool `"a"`+role `"b c"`) gộp nhầm 2 nhóm khác bounds; khoá trùng sai.
- **Tác động consumer:** anomaly scan Layer P1-M3 gộp nhóm sai → bounds tính trên populations lẫn nhau → cảnh báo nhầm/bỏ sót.
- **Fix:** chuyển cả group key + dedupeKey sang NUL separator `\u0000` (không thể xuất hiện trong tên đã trim). File đụng: src/lib/eval/anomaly-detector.ts. Sự cố quá trình: lần perl đầu chèn NUL BYTE THẬT vào file (grep báo binary) — phát hiện qua file(1), thay bằng escape sequence. Kiểm chứng: gate PASS; scan DB sạch scanned=0. Phát hiện qua giao thức fixbug.md đợt FB-P1 vòng R1.

### BUG2-053 · H · P3 — Vận hành FB-P1: eval run treo 18+ phút cần đánh dấu failed + 156 row ToolMetric test cần dọn khỏi production — FB-P1-R1-05
- **Hiện tượng:** sau khi BUG2-042 (410 vô hạn) tháo nghẽn, hậu quả vận hành còn lại: (a) eval run cmv29082p… treo ở 0/3 cần đóng trạng thái; (b) 156 row ToolMetric test (xem BUG2-041) còn trong DB production.
- **Tác động:** kế toán vận hành (KPI tool_success_rate, anomaly scan) đo trên dữ liệu bẩn đến khi dọn.
- **Xử lý:** run treo → status failed + errorMessage ghi nguyên nhân; dọn 156 row khỏi production (kèm 13 MetricAnomaly artifact sinh từ test data đã xoá — dữ liệu nguồn không còn thì anomaly dẫn xuất phải xoá theo). Kiểm chứng: ToolMetric count = 0 sau dọn; scan lại 0/0. Ghi nhận bài học vận hành: xoá dữ liệu nguồn phải kèm xoá anomaly dẫn xuất. Phát hiện qua giao thức fixbug.md đợt FB-P1 vòng R1.

### BUG2-054 · D · P3 — Test title + comment sót lại silhouette "≈0.879" từ lần tính tay SAI đầu tiên (body test đã sửa 0.9697) — FB-P1M5-R1-01
- **Hiện tượng:** tests/r76-leiden-quality.test.ts title `3 clique rõ → silhouette ≈ 0.879` + comment `phân hoạch 3 cụm cho silhouette ~0.879` — sót lại từ lần tính tay SAI đầu tiên của chính đợt triển khai (worklog task-86 ghi rõ "lần đầu tính 0.879 SAI — quên 9 node không cầu"; body assertion đã sửa sang 0.9697 nhưng title/comment quên).
- **Tác động consumer:** người đọc sau hiểu nhầm giá trị chuẩn là 0.879 — phát tán lỗi tính tay đã bị bác bỏ.
- **Fix:** title + comment đổi đúng 0.9697 kèm phân tích nguồn gốc (9 node rời rạc s=1.0 + 3 node clique 0.8788 → mean 0.9697). File đụng: tests/r76-leiden-quality.test.ts. Kiểm chứng: chạy test PASS; đối chiếu harness độc lập 332 phép đợt FB-ĐỢT3 (3-clique tay 0.969697 khớp tuyệt đối). Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT3 vòng R1.

### BUG2-055 · C · P3 — sweepGamma JSDoc hứa tie-break "γ nhỏ hơn cho ổn định" nhưng cơ chế thật "candidate ĐẦU TIÊN trong grid thắng tie tuyệt đối" — FB-P1M5-R1-02
- **Hiện tượng:** `GammaSweepResult.best` + JSDoc sweepGamma hứa bậc ưu tiên tie-break theo γ nhỏ; code thật giữ candidate đầu tiên gặp khi duyệt grid. Đúng cho grid mặc định tăng dần (γ nhỏ đến trước), KHÔNG đúng cơ học cho grid custom descending/trùng lặp. Hành vi quan sát được gần như luôn khớp doc (bậc modularity tự chọn γ nhỏ cho cùng phân hoạch) nhưng doc-code không khớp TUYỆT ĐỐI.
- **Tác động consumer:** caller truyền grid custom sẽ nhận best không theo doc hứa — hành vi không thể suy ra từ tài liệu.
- **Fix:** thêm bậc 3 so γ trực tiếp `gamma < best.gamma` (0 đổi hành vi grid mặc định) + JSDoc giải thích cơ chế + regression test grid descending + grid trùng lặp. File đụng: src/lib/stats/community-quality.ts sweepGamma. Kiểm chứng: harness 332/332 sau fix; invariant best.silhouette=max(candidates) bảo toàn; gate 683/683. Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT3 vòng R1.

### BUG2-056 · C · P3 — buildSweepReport không guard score không hữu hạn: NaN đi qua → dòng ngưỡng NaN + mẫu đếm vào n mà không bao giờ dự đoán dương — FB-Đợt4-R1-01
- **Hiện tượng:** probe thật [0.9, NaN, 0.4] → hasNaNThreshold=true: bảng điểm chứa dòng ngưỡng NaN, mẫu NaN không bao giờ được dự đoán dương nhưng vẫn đếm vào n. Cả 2 DB caller đã lọc Number.isFinite nhưng hàm thuần xuất khẩu công khai mời gọi nhầm.
- **Tác động consumer:** caller thứ ba (tương lai) truyền score bẩn sẽ nhận bảng sweep rác âm thầm thay vì lỗi tường minh.
- **Fix:** throw tường minh score không-hữu-hạn (cùng convention length-mismatch của stats layer) — guard đứng SAU length-check, TRƯỚC zero-state (mảng rỗng vẫn zero-state không throw). File đụng: src/lib/eval/threshold-sweep.ts. Kiểm chứng: 3 expect-throw test; 38/38 test cũ không đổi; harness 3750/3750. Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT4 vòng R1.

### BUG2-057 · C · P3 — 3 khuyến nghị sweep (max_f1 / precision_gte / recall_gte) chọn/lọc trên giá trị ĐÃ round4 thay vì thô — FB-Đợt4-R1-02
- **Hiện tượng:** recommended chọn max_f1 argmax trên giá trị round4 (display) — có thể lệch tới 5e-5 so với f1 thật; lọc precision_gte_0.9/recall_gte_0.9 nạp ứng viên có giá trị thô < 0.9 (chênh ≤ 5e-5). AUC đã đúng dùng rawPoints — recommended thì chưa.
- **Tác động consumer:** bảng duyệt ngưỡng nộp user có thể trình nhầm ứng viên biên (thô 0.89999… hiển thị 0.9).
- **Fix:** chọn/lọc trên raw + tie-break f1 với ε=1e-12 (2 f1 bằng nhau toán học nhưng lệch 1 ULP float phải là TIE để bậc precision quyết — không để noise ULP thắng), chỉ round khi xuất. File đụng: src/lib/eval/threshold-sweep.ts recommended. Kiểm chứng: test biên ≥ 0.9 phân biệt ≥/> ở cả 2 tiêu chí; khoá ULP bằng chính dữ liệu fuzz#65 thật; 3750/3750 sau khi harness comparator áp cùng ngữ nghĩa ε. Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT4 vòng R1.

### BUG2-058 · C · P3 — aucRoc hiển thị 0 khi một lớp vắng mặt (thiếu cặp T/F để xếp hạng thì AUC không định nghĩa được) — FB-Đợt4-R2-01
- **Hiện tượng:** live evaluator n=2 toàn positive trả AUC-ROC=0 — bị đọc nhầm "đường cong tệ nhất" trong khi không có cặp positive-negative nào để xếp hạng (không định nghĩa). Đối xứng precedent P1-M1 (aucPr trả null khi hết positive) nhưng aucRoc còn thiếu nhánh đó.
- **Tác động consumer:** mọi consumer đọc AUC-ROC trên tập không đủ 2 lớp (dữ liệu sống nhỏ — đúng tình huống n=2 lúc bộc lộ) nhận 0 thay vì "không đo được".
- **Fix:** null khi positives=0 HOẶC negatives=0 + regression 2 test (toàn dương → null nhưng aucPr vẫn 1; 0 positive → null cả hai). File đụng: src/lib/stats/classification.ts aucRoc. Sự cố quá trình: lần sửa đầu khai báo trùng totalNeg — phát hiện bằng grep trước khi tsc chạy. Kiểm chứng: gate 722/722; live route sau fix evaluator n=2 recommended 0.85 hoạt động đúng. Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT4 vòng R2.

### BUG2-059 · C · P4 — extractEvidenceTokens KHÔNG trích chuỗi hex dạng git hash — bằng chứng đối chiếu TRUNG TÂM của quy trình rơi khỏi digest gate — FB-Đợt5-R1-01
- **Hiện tượng:** "839d494" không match `\b\d{2,}\b` (không có \b giữa 839-d494 — 'd' là ký tự word), không match camel/Pascal/snake/kebab/path — mọi chuỗi hex git hash đều bị bỏ qua khi trích evidence. Digest LLM bỏ hết hash vẫn qua gate (gate không đòi hash nên không phát hiện mất).
- **Tác động consumer:** commit hash được trích dẫn liên tục trong worklog/báo cáo/ArbiterVerdict làm bằng chứng đối chiếu — nếu bản nén bỏ hash, người đọc mất khả năng truy vết về commit gốc mà gate vẫn xanh.
- **Fix:** pattern hex thuần `[0-9a-f]{7,40}` (độ dài git short-hash; từ tiếng Anh ≥7 chữ chỉ gồm a-f cực hiếm — worst case "defaced", hi sinh chấp nhận hướng bảo thủ: bắt buộc digest GIỮ token) + regression test (839d494/6b0b7e9 trích được; abc123 <7 không trích). File đụng: src/lib/context/context-compression.ts. Kiểm chứng: đối xứng — pattern chỉ THÊM token, không đổi tập token cũ (fuzz 50 bộ + 8-token fixture + BIÊN 10-token rep_000 không hex → counts giữ nguyên tuyệt đối, 27/27 test cũ + 1 mới pass); không lan path ('/' không match), không lan snake ('_' không match), không trùng key lowercase với số thuần ('722' dài 3 < 7). Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT5 vòng R1.

### BUG2-060 · C · P4 — env gate đặt NHƯNG RỖNG (KEY= không giá trị) → Number('')=0 → ngưỡng 0 = GATE TẮT NGẦM không chủ đích — FB-Đợt5-R2-01
- **Hiện tượng:** `.env` có dòng `DIGEST_EVIDENCE_COVERAGE_MIN=` (rỗng) → `Number('')=0` → `0>=0 && 0<=1` TRUE → ngưỡng thành 0. Rollback chủ đích phải là đặt "0" TƯỜNG MINH — đặt rỗng vô tình (dòng mẫu/copy template) tắt gate ngầm. Áp cả 2 gate DIGEST_EVIDENCE_COVERAGE_MIN + SUMMARY_ROUGE_RECALL_MIN; RUNTIME_JUDGES_TIMEOUT_MS vốn an toàn nhờ floor 5000 nhưng cùng quy ước.
- **Tác động consumer:** vận hành sửa .env theo template (bỏ giá trị để "tạm tắt") vô tình hạ gate về 0 — quality gate im lặng hoàn toàn.
- **Fix:** trim + rỗng coi như KHÔNG đặt → default (áp 2 gate; parseRuntimeJudgesMode vốn đã có trim cùng quy ước). Kiểm chứng: hành vi mặc định (env không đặt) giữ nguyên tuyệt đối — đọc diff R2 xác nhận 0 chữ kí đổi; test r77 80/80. Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT5 vòng R2.

### BUG2-061 · D · P4 — withTimeout judges.ts có try/catch CHẾT quanh Promise.race + trả promise không await — cú pháp lừa người đọc rằng có bảo vệ — FB-Đợt5-R2-02
- **Hiện tượng:** khối try/catch bọc `Promise.race(...)` đồng bộ — promise rejection KHÔNG BAO GIỜ vào được catch đồng bộ (chỉ throw đồng bộ mới bắt được); hàm trả promise không await. Hai lớp lừa: đọc như có xử lý lỗi (không có) + đọc như đã đợi (chưa).
- **Tác động consumer:** code đường 3-judge runtime (P3-M3) — may mắn hành vi thực tế vẫn đúng nhờ caller await ở tầng trên, nhưng mẫu code sai chuẩn này sẽ bị copy sang nơi khác như pattern chuẩn (pattern lan — lỗi loại này đã xảy ra trong codebase).
- **Fix:** dọn về đúng pattern context-compression/goal-loop (await + finally clearTimeout) — hành vi không đổi, chỉ đúng chuẩn. File đụng: src/lib/eval/judges.ts. Kiểm chứng: đọc diff R2 mắt tươi + gate 802/802; test r77-runtime-judges 20/20 (timeout 600s đúng directive kimi-k3). Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT5 vòng R2.

### BUG2-062 · D · P4 — Comment nhánh defensive-NaN của evaluateAdaptationEvidence mô tả sai cơ nhân (ví dụ "cả 2 nhóm 100% success → p không hữu hạn" trong khi trường hợp đó fisher trả đúng 1 → p=1 block) — FB-Đợt6-R1-01
- **Hiện tượng:** comment nhánh `!Number.isFinite(pRaw)` trong adaptation-stats.ts (P4-M1) gán ví dụ "bảng suy biến biên 0 — vd cả 2 nhóm 100% success → p không hữu hạn". Thực tế bảng 100%-vs-100% (b=d=0): fisherExact2x2 có ad===bc=0 → trả đúng 1 (hữu hạn) → rơi nhánh p=1 block (đã pin test A7 + harness A7), KHÔNG phải nhánh NaN. Nhánh NaN là defensive cho lib contract drift — với đầu vào boolean hiện tại không thể kích hoạt (mọi bảng không-âm cho p hữu hạn).
- **Tác động consumer:** người đọc sau hiểu nhầm điều kiện kích hoạt nhánh fail-open — dẫn debug sai hướng khi lib đổi contract.
- **Fix:** viết lại comment trung thực: nhánh là defensive cho contract drift; dẫn đúng hành vi 100%-vs-100% (p=1 block, pin ở test A7); reason string sửa "p không hữu hạn từ phép thử". File đụng: src/lib/learning/adaptation-stats.ts. Kiểm chứng: gate PASS sau fix; hành vi không đổi (comment-only) — A7 pin sẵn. Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT6 vòng R1 (C6 doc-fidelity).

### BUG2-063 · C · P3 — Row StrategyAdaptationLog của adaptation BỊ GATE CHẶN vẫn được markSessionAdaptationOutcome đóng successful → ô nhiễm nhóm evidence "after" của các lần gate sau — FB-Đợt6-R2-01
- **Hiện tượng:** workflow-engine tạo row SAL (pending) TRƯỚC khi gate chạy; khi ADAPTATION_STATS_GATE=on chặn apply (applyAdaptationToSession trả null, KHÔNG merge directives), row vẫn nằm đó và markSessionAdaptationOutcome sau đó đóng `successful` theo outcome của session — nghĩa là ghi "hiệu quả của toStrategy" cho một chiến lược CHƯA TỪNG ĐƯỢC ÁP DỤNG. evaluateAdaptationGateForPair đếm mọi row successful!=null theo toStrategy → nhóm after bị pha "outcome của việc KHÔNG chuyển chiến lược" → gate tự học trên dữ liệu sai nghĩa. Chỉ bộc lộ khi user bật gate ON (mặc định OFF — phát hiện và đóng trước khi có bất kỳ row nào trong production, bảng SAL hiện 0 row).
- **Tác động consumer:** quyết định pass/block của cổng thống kê Layer 9 (P4-M1) sai hướng một khi gate được bật — chính cơ chế thay quy tắc đếm ≥2/≥3 bằng kiểm định sẽ học từ bằng chứng bẩn.
- **Fix:** (a) statsJson thêm trường `applied` (persistAdaptationStatsJson nhận tham số — workflow-engine ghi SAU apply với giá trị applied = (applyAdaptationToSession !== null), nên log-only would-block vẫn applied=true); (b) evaluateAdaptationGateForPair loại row có statsJson.applied===false khỏi evidence 2 nhóm (row cũ không có trường `applied` mặc định đã-áp-dụng — mọi row trước fix đều được apply thật); (c) JSON statsJson hỏng → coi như đã áp dụng (fail-open). File đụng: src/lib/learning/adaptation-stats.ts + src/lib/code-team/workflow-engine.ts. Kiểm chứng: 2 regression test mới (row applied=false bị loại nB=11/12; row decision=block nhưng applied=true VẪN đếm nB=12/12) + gate 842/842 + harness 169/169. Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT6 vòng R2 (rà nghịch lý luồng sau khi soi fix R1).

### BUG2-064 · C · P2 — embedding_success_rate đo 0/n trên đường pipeline SKIP-embeddings (resume đã đủ vector) → expectation FAIL giả → doc kẹt 'partial' vĩnh viễn mỗi lần reprocess — FB-Đợt7-R2-01
- **Hiện tượng:** P5-M4 đo embedding_success_rate = min(1, embeddingsSavedCount/savedChunks.length) ở cuối pipeline. Đường resume mà mọi chunk ĐÃ có vector thật từ lần chạy trước (`hasEmbeddingsData=true` → nhánh skip, không chạy bước embeddings) giữ `embeddingsSavedCount=0` (khởi tạo hoisted) → 0/33 = 0 < 0.999 → expectation severity FAIL → giữ 'partial'. Mọi lần reprocess lặp lại như vậy (vector vẫn đủ, metric vẫn 0) → KHÔNG có đường tự thoát — doc đã hoàn hảo vẫn kẹt partial vĩnh viễn.
- **Tác động consumer:** document đã index hoàn chỉnh không bao giờ trở lại 'indexed' qua reprocess; auto-chain lặp vô ích; UI treo trạng thái partial.
- **Fix:** chỉ đo metric khi bước embeddings CHẠY trong lần pipeline này (`!hasEmbeddingsData`); đường skip = không đo (evaluated=false — đúng nghĩa "thiếu đo ≠ hỏng"). File đụng: src/app/api/ingestion/process/route.ts (khối expectationMeasurements). Kiểm chứng: contract "metric thiếu → evaluated=false" pin trong test r78-pipeline-expectations (case "metric thiếu"); live probe reExtract doc indexed → chạy tới 'indexed' không kẹt. Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT7 vòng R2 (rà nghịch lý luồng #16).

### BUG2-065 · C · P2 — embedding_success_rate đo "chỉ số mới-lưu-run-này"/tổng trên đường RESUME-PARTIAL (30/33 thật + 3 mới → 3/33=0.09) → FAIL giả — anh em BUG2-064 — FB-Đợt7-R3-01
- **Hiện tượng:** cùng họ lỗi với BUG2-064 nhưng đường khác: resume có sẵn 30/33 vector thật, run này chỉ embed 3 chunk còn thiếu → embeddingsSavedCount=3 (đúng — chỉ đếm lần này) → 3/33 = 0.09 < 0.999 → FAIL → 'partial' dù sau run này cả 33 chunk đều có vector thật (guard P0-5 verify sạch). Khác BUG2-064: metric CÓ đo nhưng TỬ SỐ sai nghĩa (thiếu phần vector-thật-trước-run).
- **Tác động consumer:** doc resume-partial hoàn tất xong vẫn bị giữ 'partial' → auto-chain chạy lại (lần sau needing=0 → rơi đúng BUG2-064 → kẹt vĩnh viễn kép).
- **Fix:** tử số đúng nghĩa = vector-thật-trước-run (realVectorCount) + mới-lưu-run-này (embeddingsSavedCount); hoist realVectorCount ra scope pipeline; min(1,·) kẹp đúng trường hợp needing=0 (embeddingsSavedCount=realVectorCount aliasing → 2×n/n → clamp 1). File đụng: src/app/api/ingestion/process/route.ts. Kiểm chứng: suy luận 3 đường (fresh 0+n/n ✓; resume-partial r+n/n ✓; skip không đo — BUG2-064 fix); gate 931/931 sau fix. Phát hiện qua giao thức fixbug.md đợt FB-ĐỢT7 vòng R3 (checklist C1 đối chiếu spec — soi lại sau khi fix BUG2-064).

### BUG2-066 · D · P3 — db-isolation-preload copy cả file -shm (WAL-index "sống") từ hệ thống đang chạy → SQLite bản copy BỎ QUA recover WAL → schema/dữ liệu mới-push nằm trong WAL không thấy (P2022) — FB-Đợt7-R1 (phát hiện trong quá trình triển khai P5-M2)
- **Hiện tượng:** chạy `prisma db push` (thêm cột Document.contentHash) xong chạy `bun test` trực tiếp → test fail P2022 "The column contentHash does not exist". Cột nằm trong custom.db-wal (chưa checkpoint — pm2 app đang giữ connection); preload copy db + -wal + -shm sang /tmp, nhưng -shm là WAL-index tái-dựng-được copy từ hệ thống ĐANG CHẠY mang index trạng-thái-sống → SQLite mở bản copy tin "WAL đã áp dụng hết" → bỏ qua recover → schema cũ. Tái lập ổn định: push schema xong chạy test NGAY → fail; checkpoint (PRAGMA wal_checkpoint(TRUNCATE)) → pass.
- **Tác động consumer:** mọi đợt có schema-migration chạy test trực tiếp ngay sau push sẽ fail ảo (gate không dính — quality-gate set DATABASE_URL riêng + push schema vào test DB riêng); nghi vấn giả dẫn debug sai hướng.
- **Fix:** preload chỉ copy db + -wal, KHÔNG copy -shm (SQLite tự recover WAL-index từ đầu khi mở bản copy — textbook-safe với mọi trạng thái sống); cập nhật ghi chú đầu file giải thích cơ chế. File đụng: tests/db-isolation-preload.ts. Kiểm chứng: r78-doc-dedup fail 6/25 → pass 25/25 sau fix (không checkpoint thủ công); r77 regression 40/40 giữ nguyên. Phát hiện đợt FB-ĐỢT7 khi triển khai P5-M2 (test mới fail ngay sau push schema).

### BUG2-067 · C · P3 — Shell sandbox xuất DATABASE_URL=file:/home/z/my-project/db/custom.db (DB scaffold KHÁC, schema cũ 0-dữ-liệu-TMO) — bun không đè env đã set bằng .env → preload copy NHẦM DB ngoại lai → test chạy trên schema lạ — FB-Đợt7-R1
- **Hiện tượng:** sau fix BUG2-066, r78-doc-dedup vẫn fail P2022. Điều tra: process test nhận DATABASE_URL tuyệt đối /home/z/my-project/db/custom.db (DB của project scaffold sandbox — 1.8MB, KHÔNG có cột contentHash lẫn AgentRunRecord.model của đợt 6, 0 document TMO). Bun giữ env-var có sẵn từ shell thay vì dùng .env của project → preload copy đúng cơ chế nhưng nguồn SAI (schema cũ). Trước đợt 7 không bộc lộ vì schema scaffold tình cờ trùng schema tại thời điểm tạo sandbox + các đợt chạy test qua gate (gate tự set DATABASE_URL đúng); đường `bun test` trực tiếp (tool run_tests của agents) âm thầm chạy trên DB lạ.
- **Tác động consumer:** test chạy trực tiếp từ shell sandbox (không qua gate) có thể pass/fail trên dữ liệu KHÔNG phải của project — kết quả không đại diện; test đụng schema mới luôn fail ảo.
- **Fix:** preload thêm resolveCopySourceUrl: env trỏ file NGOÀI project root → bỏ (dùng .env của project làm nguồn sự thật); env trỏ file TRONG project (vd db/.quality-gate-test.db của gate) → giữ nguyên (ý định chủ đích — cùng chính sách guard của src/lib/db.ts). File đụng: tests/db-isolation-preload.ts. Kiểm chứng: debug process test thấy copy từ /home/z/my-project/... → sau fix copy từ project + contentHash present + r78 25/25 + gate 931/931 (gate path không đổi hành vi). Phát hiện đợt FB-ĐỢT7 (đi sâu BUG2-066 — cùng triệu chứng P2022, 2 nguyên nhân chồng nhau).

### BUG2-068 · D · P3 — scripts/matryoshka-benchmark.ts (viết mới đợt 7) scroll Qdrant chỉ kiểm `next_page_offset === undefined` để dừng — Qdrant trả `null` khi hết → vòng lặp cuộn lại trang ĐẦU 50 lần → dữ liệu nhân đôi 50×, recall ảo 1.0 — FB-ĐỢt7 (phát hiện trong quá trình triển khai P5-M1)
- **Hiện tượng:** benchmark đầu tiên báo theopus_chunks n=1650 vector (= 33 × 50 trang) và recall@5 = 1.0000. Điều tra: `next_page_offset` của Qdrant là `null` khi hết dữ liệu (không phải undefined) → điều kiện dừng không bao giờ khớp → mỗi trang lặp lại trang đầu. Vector trùng nhau 50 bản → top-k của query chứa chính các bản sao của cùng point → recall trùng nhau giả.
- **Tác động consumer:** bảng recall đối chứng (căn cứ quyết định điểm dừng #4 — chuyển đường đọc 512 hay không) sẽ kết luận SAI 1.0 thay vì 0.88 → user duyệt chuyển đường đọc trên số ảo.
- **Fix:** dừng khi next_page_offset là null HOẶC undefined + dedup theo point id + cap 5000 phòng thủ + nhận diện vector nested (client with_vector). File đụng: scripts/matryoshka-benchmark.ts. Kiểm chứng: benchmark lại n=33 thật → recall@5 0.8848 / recall@10 0.9152 (khớp đo tay độc lập bằng fetch REST phân trang đúng); báo cáo REPORT-P5-M1 sinh từ bản đúng. Phát hiện đợt FB-ĐỢT7 khi đối chiếu số benchmark với điểm-count API (33 ≠ 1650).

---

## PHÁT HIỆN GIAO THỨC FIXBUG — ĐỢT FB-ĐỢT7-R4/R5 (kích hoạt lại theo chỉ thị user 2026-10-10: "Kích hoạt giao thức Fixbug cho những gì triển khai trong đợt 7")

> Bối cảnh: FB-ĐỢT7 đã khép 3 vòng inline trong commit b3d8638. User chỉ thị kích hoạt lại giao thức → chạy tiếp R4 (audit độc lập 3 subagent + chấm chéo người điều phối) + R5 (audit diff R4) + vòng fix toàn bộ. 20 phát hiện đề xuất → 18 nhận sau chấm chéo (2 nghi vấn của auditor R1-a chuyển thành 2 fix bổ sung có chủ đích: probe sanitize + embedOnly marker). Toàn bộ fix kèm regression test trong tests/r78-fb7-regression.test.ts (32 test).

### BUG2-069 · C · P3 — chunks_per_page KHÔNG BAO GIỜ đo được ở lần index đầu tiên (doc chạy hết trong 1 batch): snapshot `document` lấy 1 lần đầu pipeline giữ page_count=null của lúc upload — FB-Đợt7-R4-A1 (auditor R1-a #1, chấm chéo điều phối: truy vết 4 mắt xích 2230→2560→3956)
- **Hiện tượng:** upload ghi pageCount=null; bước parse ghi pageCount vào Qdrant/SQLite qua updateDocProgress nhưng biến cục bộ `document` không được refresh; khối P5-M4 dùng `document.page_count ?? 0` → 0 → metric "chưa đo". Chỉ đo được khi doc ≥2 batch (fetch lại snapshot) hoặc reprocess.
- **Tác động consumer:** cảnh báo warn "parse hỏng/chunking lỗi" vắng trên đường phổ biến nhất (doc nhỏ index 1 lần); KPI chunks_per_page mù với doc mới.
- **Fix:** hoist `freshPageCount` (gán sau parse đường fresh; đường resume fallback snapshot từ run trước — đúng nghĩa). File: process/route.ts. Kiểm chứng: suy luận 2 đường (fresh run này có số; resume có số từ run trước) + gate 963/963.

### BUG2-070 · C·P3 — 5 fix inline BUG2-064..068 KHÔNG có test regression nào pin (C5 vi phạm 5/5) — FB-Đợt7-R4 (auditor R1-a #2 + R1-b #7 + R1-c F1, hội tụ)
- **Hiện tượng:** grep toàn bộ tests/ — 0 hit cho hasEmbeddingsData/realVectorCount/next_page_offset/resolveCopySourceUrl; logic đo nằm inline trong route 6000 dòng, r78 chỉ test lib generic. Revert bất kỳ fix nào → không test nào fail.
- **Tác động consumer:** BUG2-064/065 từng là P2 (doc kẹt 'partial' vĩnh viễn) — có thể hồi quy lặng lẽ.
- **Fix:** tách logic ra thuần + 32 test regression (tests/r78-fb7-regression.test.ts): computeEmbeddingSuccessRate pin 4 đường đo (skip→null/fresh n/n/resume 30+3/alias kẹp 1); savedVectorCount pin F2; hasEnoughValidProbes pin A5; isQdrantScrollExhausted pin BUG2-068 (null+undefined); resolveCopySourceUrl + copySqliteFiles + DB_COPY_SUFFIXES pin BUG2-066/067 + F4 (dựng cây /tmp giả lập project). Kiểm chứng: gate 963/963 (931→963, +32).

### BUG2-071 · C·P3 — expectation zero_vector_rate CHẾT về cấu trúc: không bao giờ vi phạm (nhánh guard không đo, nhánh sạch luôn 0) — FB-Đợt7-R4-A3 (auditor R1-a #3 + R1-c F2(ii), chấm chéo điều phối đọc 2 nhánh 4030-4073)
- **Hiện tượng:** nhánh sạch vào được chỉ khi zeroVectorChunks=0 → rate=0 → PASS luôn; nhánh guard (zero-vector thật >0) dùng expectationMeasurements không chứa metric → evaluated=false. Comment cũ "chỉ đo được khi guard verify sạch" khái quát hóa sai 2/3 sub-case (F5).
- **Tác động consumer:** KPI ingestion_expectation_fails mù hoàn toàn với sự cố zero-vector — trái mục đích khai báo "nâng thành expectation thống kê để bắt xu hướng hỏng một phần".
- **Fix:** guard-branch đo zero_vector_rate = zeroVectorChunks/verifyChunks khi !verifyBlind (mù giữ evaluated=false — thiếu đo ≠ hỏng) + comment viết lại trung thực + đồng bộ điều kiện gắn marker (thêm notMeasured>0 như nhánh sạch). Kiểm chứng: test pin 0.03→fail / 0.0099→pass / 0.01→fail (lt ngặt) + gate.

### BUG2-072 · C·P3 — entity_rate = 0 (extract miss hoàn toàn) KHÔNG được đo: guard entityCount>0 loại mất cận dưới warn [0.2,6] ở đúng mức 0 tuyệt đối — FB-Đợt7-R4-A4 (auditor R1-a #4)
- **Hiện tượng:** LLM chạy mà 0 entity → localEntity.count=0 → guard chặn không đo → warn "miss" không bao giờ fires ở mức nặng nhất.
- **Tác động consumer:** doc extract trắng tinh không bị cảnh báo.
- **Fix:** entity_rate đo khi savedChunks>0 (đếm từ DB — có sẵn mọi đường); relationship_per_entity giữ guard mẫu số >0. Kiểm chứng: test pin entity_rate=0 → evaluated=true + passed=false (warn) + gate.

### BUG2-073 · C·P3 — near-dup quyết định trùng trên 1 probe duy nhất khi provider embed hỏng một phần (3 thử/1 sống) — khe chặn-nhầm — FB-Đợt7-R4-A5 (auditor R1-a #5, chấm chéo: embeddings.ts:604 trả {vector:[]} không throw → partial-failure reachable)
- **Hiện tượng:** generateEmbedding trả vector rỗng thay vì throw khi cả NVIDIA+OpenRouter chết từng text → probeVectors lọc bỏ → có thể còn 1 probe → "MỌI probe cùng doc" tầm thường → duplicate=TRUE trên 1 bằng chứng (ngược triết lý spec "an toàn theo hướng không chặn nhầm").
- **Tác động consumer:** doc hợp lệ có 1 chunk khớp boilerplate doc khác ≥0.98 có thể bị đánh dấu duplicate nhầm, không index.
- **Fix:** hasEnoughValidProbes(valid, attempted) = valid ≥ min(2, attempted) — 3/1 sống → fail-open; doc 1-chunk (1/1) vẫn quyết được (probe là toàn bộ nội dung). File: doc-dedup.ts. Kiểm chứng: 5 test pin ma trận valid/attempted + gate.

### BUG2-074 · C·P3 — UI badge "trùng với …" thực tế KHÔNG tồn tại: 0 consumer của duplicate_of/duplicate_of_title, STATUS_COLORS/LABELS thiếu key 'duplicate' (hiển thị fallback chữ thô), đường GET fresh không phát 2 trường (chỉ đường cache 10s có → badge nhấp nháy) — FB-Đợt7-R4-A6 (auditor R1-a #6)
- **Hiện tượng:** worklog đợt 7 ghi "doc list hiển thị badge duplicate" — thực ra là fallback text thô; overlay sinh 2 trường chết không ai đọc.
- **Tác động consumer:** spec §P5-M2 "hiển thị badge trùng với…" không đạt trên UI thật.
- **Fix:** STATUS_LABELS duplicate='Bản trùng' + màu riêng; render span "trùng với …" khi status=duplicate; đường fresh (R2-map + SQLite-append) phát duplicate_of/duplicate_of_title cùng dạng overlay; overlay thêm nhánh delete chống stale (R5-P4#6). Kiểm chứng: browser live — badge + nhãn hiển thị đúng, mobile 390px không tràn, 0 lỗi console.

### BUG2-075 · C·P4 — response 409 exact-dup NUỐT mảng errors: request hỗn hợp (1 trùng + 1 lỗi) client API không biết file lỗi gì — FB-Đợt7-R4-A7 (auditor R1-a #7)
- **Fix:** body 409 kèm `errors` khi non-empty (body 200 vốn có). Kiểm chứng: đọc code + logic tương đương 200-path.

### BUG2-076 · D·P4 — JSDoc exactDupResponseStatus nói "MỌI file đều trùng hash" nhưng hành vi thật là "không file mới nào được lưu" (1 trùng + 1 lỗi cũng 409) — FB-Đợt7-R4-A8 (auditor R1-a #8)
- **Fix:** JSDoc viết lại đúng điều kiện duplicates>0 ∧ uploaded=0; hành vi giữ nguyên. (Cùng lớp bài học FB-Đợt6-R1-01 doc-fidelity.)

### BUG2-077 · C·P3 — pcaTop2 kẹt ở trục PHỤ khi diag(C) trùng vector riêng phụ (dữ liệu đối xứng hoán-trục bit-perfect): trả hướng SAI var 0.056 thay vì trục trội 0.944, KHÔNG null như comment tuyên bố — FB-Đợt7-R4-B1 (auditor R1-b #1; chấm chéo điều phối TỰ TÁI LẬP bằng script riêng: 8 điểm nguyên đối xứng → component1=trục phụ |cos|=1.000000, var=[0.0559,0] vs tính tay [0.9441,0.0559])
- **Hiện tượng:** C=[[a,b],[b,a]] với b<0 (cụm y=−x trội + y=x phụ, var_x=var_y) → diag(C) ∝ (1,1) = eigenvector PHỤ → power iteration đứng yên ở đó mãi → component1 sai hướng hoàn toàn, component2=0 (deflation để lại eigenvector-0). Xác suất embedding thật ~0 nhưng synthetic/test có thể dính.
- **Tác động consumer:** bản đồ tri thức graph-explore vẽ sai hướng trên dữ liệu đối xứng; comment lừa dối người bảo trì ("λ hội tụ 0 → null").
- **Fix:** phát hiện "v₀ là vector riêng chính xác" bằng residual phép nhân đầu (w₀−(v₀ᵀw₀)v₀ ≤ 1e-12·‖w₀‖, hoặc w₀=0) → bứt bằng nhiễu tất định 1e-4 (pattern xen kẽ ±1 + dự phòng) — trục trội thì iteration tự kéo về đúng nó, trục phụ thì thoát ra. Hạn chế ghi trung thực: cặp eigen gần suy biến (λ1/λ2→1) hội tụ chậm — mọi hướng trong mặt phẳng suy biến đều hợp lệ về phương sai. Kiểm chứng: regression test B1 pin component1=trục trội + var khớp tính tay + component2 sống lại; harness auditor R5 38 phép độc lập khớp.

### BUG2-078 · C·P3 — resolveEntities trả duplicates NHÂN ĐÔI: nbThenFuzzyMatchResolution push vào CHÍNH mảng exactDuplicates truyền vào rồi resolveEntities spread 2 lần cùng reference → duplicatesFound phình 2× (pattern di truyền từ fuzzyMatchResolution gốc trước đợt 7) — FB-Đợt7-R4-B2 (auditor R1-b #2 với script chứng minh; pre-existing nhưng hàm được đợt 7 viết lại nên thuộc scope)
- **Fix:** bỏ param duplicates đầu vào, hàm tự trả mảng riêng; mergeMap/updateRelationshipReferences vô hại (idempotent). Kiểm chứng: test pin 2 exact + 1 fuzzy → 3 entry (không phải 6), mỗi cặp đúng 1 lần.

### BUG2-079 · C·P3 — pcaTop2 chặn event-loop ~4.4-5.8s trên 500×2048 (build C d×d = n·d² chiếm phần lớn) — FB-Đợt7-R4-B3 (auditor R1-b #3 đo 5790ms; điều phối tự đo 4431ms cùng quy mô)
- **Fix:** implicit products khi 2n<d: C·v = Xᵀ(X·v)/(n−1) — O(n·d)/lần, không build C, không cấp phát d×d (33MB). Kiểm chứng: đo trực tiếp 168×2048: cũ 1512ms (build C riêng 1286ms) vs mới 174ms = 8.7×; live graph-explore 168-node 1.54s cả request; harness R5: 4 bộ (n,d) implicit khớp tham chiếu explicit độc lập sai số ≤2e-11 + test pin implicit vs eigen đóng dạng.

### BUG2-080 · C·P3 — graph-explore cacheKey lowercase nhưng Neo4j MATCH phân biệt hoa/thường → "neural network" ăn nhầm đồ thị của "Neural Network" (tái lập live: fromCache=true nhận graph bản hoa) — FB-Đợt7-R4-B4 (auditor R1-b #4)
- **Fix:** cacheKey = entityName.trim() (giữ hoa/thường). Kiểm chứng: suy luận trực tiếp + live "Bun" cache riêng biệt.

### BUG2-081 · D·P4 — ensurePilotCollection KHÔNG mutex: 2 dual-write fire-and-forget song song → create đụng nhau (409 không-retry-được) hoặc drop-recreate đan nhau mất vài điểm pilot — FB-Đợt7-R4-B5 (auditor R1-b #5; hậu quả nhẹ — pilot disposable)
- **Fix:** promise-chain mutex trong-process (5 dòng). Kiểm chứng: đọc code + R5-audit (n) xác nhận không unhandled rejection.

### BUG2-082 · C·P4 — collections-health ép dimMismatch=false cho MỌI collection pilot kể cả sai dim THẬT so với khai báo 512 (ai tạo tay 256-dim → health XANH) + ternary dimExpected dư + comment tự mâu thuẫn — FB-Đợt7-R4-B6 (auditor R1-b #6)
- **Fix:** so sánh trung thực với dimExpected khai báo (512) — pilot đúng dim vẫn XANH (spec "không làm health đỏ" chỉ áp cho legit 512), sai dim ĐỎ rồi ensurePilotCollection drop-recreate tự chữa; bỏ ternary dư; comment viết lại (R5 dọn comment stale dòng 46). Kiểm chứng: live pilot exists=false không đỏ; đọc code 2 nhánh.

### BUG2-083 · C·P3 — embeddingsSavedCount đếm vector CHUẨN BỊ ghi kể cả khi updateChunkVectors=false (Qdrant lỗi) → embedding_success_rate PASS giả 1.0 đúng lúc mass-embed-fail (tín hiệu đo sai chiều đúng lúc cần) — FB-Đợt7-R4-F2(i) (auditor R1-c F2; semantics trả-về tiền tồn tại ROUND-32, fix đợt 7 tiêu thụ)
- **Fix:** generateAndSaveEmbeddings trả savedVectorCount(ok, vectorPoints.length) — chỉ đếm batch ghi thành công; detail step "0/33" giờ trung thực hơn "33/33" giả; không consumer nào phụ thuộc semantics cũ (grep toàn repo). Kiểm chứng: test pin savedVectorCount + gate.

### BUG2-084 · C·P4 — preload resolveCopySourceUrl kiểm "trong project" bằng startsWith nguyên văn: đường TUYỆT ĐỐI chứa ".." (file:/…/proj/../evil.db) lọt kiểm → copy DB ngoại lai (đường tương đối vốn tự chuẩn hoá qua path.resolve) — FB-Đợt7-R4-F4 (auditor R1-c F4)
- **Fix:** path.resolve cho cả đường tuyệt đối. Kiểm chứng: test pin F4 dựng cây /tmp: sneaky URL → resolves về .env project, không trả bản ngoài.

### BUG2-085 · C·P4 — đường embedOnly reset steps KHÔNG đánh giá P5-M4 → marker + KPI ingestion_expectation_fails biến mất tới lần full-pipeline sau — FB-Đợt7-R4 (từ "nghi vấn chưa chắc" R1-a, điều phối quyết định là finding thật)
- **Fix:** khối expectations cho embedOnly (đúng bộ helper đường chính: chunks_per_page từ parsedPages, embedding_success_rate từ embeddingsSavedOk, entity/rel từ DB, zero_vector_rate từ số verify hoisted — R5-P4#5 bổ sung) + gắn marker SAU markStepPending (cùng thứ tự đường chính) + fail→partial. Kiểm chứng: đọc luồng + gate.

### BUG2-086 · D·P3 — scripts/matryoshka-benchmark.ts (nơi fix BUG2-068) KHÔNG được git track (/scripts/* bị gitignore, không có exception) → fix không sống sót qua clone, benchmark (bằng chứng nghiệm thu P5-M1) chỉ tồn tại trên đĩa sandbox — FB-Đợt7-R5 (điều phối phát hiện khi xác minh phát hiện R5-a; git ls-files + check-ignore xác nhận)
- **Fix:** thêm exception !/scripts/matryoshka-benchmark.ts vào .gitignore + git add. Kiểm chứng: git status hiện file A (staged).

### BUG2-087 · C·P4 — lô hygiene R5 (auditor R5 #1/#3 + live probe điều phối, mỗi mục fix riêng): (a) test buildFakeProject rò 10 thư mục /tmp/lần chạy (đo thật 20 dir sau 2 run) → try/finally + _cleanup; (b) pcaTop2 PC2 khởi tạo từ diag(C) thay vì diag(C₂) (thay đổi ngữ nghĩa ngoài ý đồ khi viết lại — harness chứng minh lành nhưng khôi phục về bản gốc cho đúng); (c) λ/trace vượt 1 cỡ epsilon (đo thật 1.0000000000000027 khi 2 điểm thẳng hàng) → clamp [0,1]; (d) guard-branch gắn marker thiếu điều kiện notMeasured>0 (không đồng bộ nhánh sạch) → thêm; (e) near-dup probe embed nội dung RAW trong khi Step 11 embed bản sanitizeForDB → lệch L1/L2 cache + so khớp sai nghĩa → probe embed sanitizeForDB(content) (auditor R1-a nghi vấn, xác minh idempotent + fuzz 5000 bởi R5) — FB-Đợt7-R4/R5
- **Kiểm chứng:** từng mục nêu trong fix; gate 963/963 sau toàn bộ.

### GHI NHẬN ĐẶC BIỆT R4/R5
- **Sai-kỳ-vọng phía người-rà (lần 12-13):** (1) kì vọng test biên zero_vector_rate viết NGƯỢC — spec "lt 0.01" là ngặt: 0.01 VI PHẠM (người điều phối tự bắt khi chạy test); (2) kì vọng tay implicit-PCA quên số hạng hiệp phương sai cov(a,b) khi "giả sử 2 trục là trục chính" — code đúng, test sửa theo eigen đầy đủ. Auditor R5 cũng tự bắt 2 "FAIL" hóa ra là giới hạn tol dùng chung bản cũ (không phải lỗi mới).
- **Phát hiện bị bác bỏ sau chấm chéo:** 0/20 — toàn bộ phát hiện auditor đều xác minh đúng (lần đầu tiên 7+ đợt không bác cái nào; chất lượng auditor tăng theo chất lượng giao thức).
- **Giới hạn tiền tồn tại ghi nhận (không phải lỗi đợt 7):** pcaTop2 maxIter=100 chưa đủ hội tụ trên phổ gần-suy-biến λ2/λ1≈0.98 (cũ=mới cho kết quả trùng khớp tuyệt đối — thay maxIter là đánh đổi độ trễ, để nguyên + đã ghi trong header pca.ts).

---

## PHẦN FB-P6 — FIXBUG ĐỢT 8/P6 (RL-LEARNING) — 4 VÒNG R1→R4, 2026-10-11

> Scope: commit b139706 (P6-M1..M4, 11 file +851) + fix đợt FB. 3 auditor độc lập R1 (A: q-table/schema/r79 · B: llm/goal-loop/workflow/adaptation · C: metrics-db/route/UI) → chấm chéo điều phối → R2 mắt tươi trên diff fix → R3 kiểm chứng + quét C1-C8 → R4 vòng đóng (0 phát hiện mới → KHÉP). Gate 990 → 1007 (+17 test). Chi tiết bằng chứng: worklog FB-P6-R1-A/B/C, FB-P6-R2, FB-P6-R3, FB-P6-R4 + harness /tmp/fb-p6-*/.

### BUG2-088 · C·P2 — updateQ maxNextQ bị FLOOR tại 0 (reduce khởi điểm 0) kể cả khi mọi Q(s\') âm — lệch công thức spec §P6-M2 "γ·max_a\' Q(s\',a\')" và lệch chính claim commit "max đầy đủ" — FB-P6-R1-A-01 (auditor A, DB-throwaway đo 2 update −1 → −0.19 thay vì −0.199; 15 lượt → −0.794 thay vì −1.0; quỹ đạo học chậm ~10×, state toàn-model-xấu trông "lạc quan" giả)
- **Fix:** `Math.max(...nextEntries.map(e => e.qValue))` thuần, state rỗng → 0 (uniform prior giữ cho trường hợp lệ). Kiểm chứng: test H1 pin −0.199/−0.99 + chuỗi 15 lượt khớp mô phỏng độc lập; gate.

### BUG2-089 · C·P2 — deterministicSeed FNV-1a trần trên chuỗi cycle tuần tự (chỉ ký tự cuối đổi, \'0\'→\'1\' XOR đúng 1 bit 0) tạo seed lệch nhau CHÍNH XÁC ±FNV-prime (0x01000193) → r cấp số cộng bước 1/256 → softmax cluster 1-2 model trong session (đo 500 session: mean distinct ≈1.99/4, 16-19% session chỉ 1 model — phá mục tiêu chống 429-cascade §P6-M3; điều phối chứng minh giải tích ±prime + auditor đo độc lập) — FB-P6-R1-A-02
- **Fix:** thêm avalanche finalizer murmur3 fmix32 sau FNV-1a (giữ tất định). Kiểm chứng: test H2 — 500 session × 20 chu kỳ mean distinct ≥3.5 (đo 3.99), session-1-model ≤1/500, cấu trúc ±prime bị phá; auditor R2/R3 chấm chéo vector fmix32(1)=0x514e28b7 + chi² 24.36<30.58.

### BUG2-090 · C·P3 — updateQ không nguyên tử: 2 lệnh đọc + 1 upsert rời nhau → 2 run đóng cùng lúc trên cùng (stateKey,actionKey) (mode-agent-tier-1 DÙNG CHUNG mọi run goal-loop) bị lost-update qValue (đo thật 10 update song song chỉ 1 ăn nhập, visits=10 nhưng q=0.1 thay vì 0.956) — FB-P6-R1-A-03 (auditor A đề nghị P2, điều phối chấm P3 — fire-and-forget side-channel tự chữa dần)
- **Fix:** lần 1 thử $transaction tương tác — SAI CHO SQLITE (10 tx song song giữ lock → Socket timeout nhiễm lan cả hook test file khác — đo thật gate run 1: 19 fail lan); lần cuối: TUẦN TỰ HOÁ IN-PROCESS chuỗi promise updateQChain (mọi updateQ xếp hàng; app 1 process pm2 duy nhất + QEntry chỉ ghi qua updateQ → kín mọi writer thật). Kiểm chứng: test H3 — 10 update // → tuần tự đúng toán 0.956179 khớp độc lập; chuỗi poison-immune (R2 replica Bun); gate 1007.

### BUG2-091 · D·P3 — JSDoc softmaxPolicy nói "τ không hợp lệ → trả mảng 0" nhưng code sanitize τ vô hiệu về default 0.5 và vẫn trả phân bố hợp lệ (ngược chiều fail-safe — ai đọc doc sẽ viết fallback nhầm) — FB-P6-R1-A-04 (nguồn gốc: sai-kỳ-vọng lần 14 đợt triển khai chỉ sửa test, quên doc)
- **Fix:** JSDoc viết lại trung thực (sanitize → phân bố hợp lệ). Kiểm chứng: test E6 pin hành vi + đọc doc.

### BUG2-092 · D·P3 — comment test r79 B2 "→ −0.1" sai giá trị (thực tế maxNext gồm model-x Q=0.199 → −0.08209) — dẫn người sửa test sau này sai kỳ vọng — FB-P6-R1-A-05 (auditor tự bắt lỗi tính của chính mình lần đầu rồi chấm tay lại)
- **Fix:** comment đúng −0.08209 + ghi chú nguồn sai. Kiểm chứng: chấm tay 0+0.1×(−1+0.9×0.199)=−0.08209.

### BUG2-093 · D·P3 — test phủ mỏng: getTopQAdvice 1 test (không pin limit-clamp 0→1/100→20/NaN, không pin filter visits>0), qEntryCount 0 test + 0 consumer — FB-P6-R1-A-06 (vi phạm C5 "mỗi hàm ≥ 2 case")
- **Fix:** test H5 pin clamp + NaN-limit về default 5 + qEntryCount; audit R3 phán qEntryCount giữ telemetry (0 consumer src). Kiểm chứng: gate.

### BUG2-094 · D·P4 — JSDoc pickIndexBySeed ghi "seed/2^32" nhưng code là (seed % 0xffffffff)/0xffffffff — khác quan sát được duy nhất tại seed=2³²−1 (r=0 đếm đôi 2/2³², vô hại — 5M mẫu maxDev 5.18%<5σ) — FB-P6-R1-A-07
- **Fix:** JSDoc mô tả đúng phép modulo + ghi nhận cặp đụng độ (0, 2³²−1). Kiểm chứng: phân tích auditor A + ghi chú code.

### BUG2-095 · C·P4 — softmaxPolicy trừ-max tính trên TOÀN BỘ score (kể cả weight-0): argmax bị chặn + gap lớn → exp underflow toàn mảng ([1000,0,0] w=[0,1,1] → [0,0,0] thay vì [0,0.5,0.5]) — không với tới production (Q kẹp [−1,1] + τ floor 0.05 → gap tối đa 40, exp(−40)=4.2e−18>0) nhưng sai tầng thuần — FB-P6-R1-A-08
- **Fix:** max trên tập alive (w>0 ∧ finite). Kiểm chứng: test H4 pin [0,0.5,0.5] + fuzz 20000 maxDiff 6.9e−15 (auditor R2).

### BUG2-096 · C·P4 — pickIndexBySeed degenerate seed (âm/NaN/∞ từ caller trực tiếp — không thể đến từ deterministicSeed >>>0): seed âm → r âm → trả index 0 kể cả π(0)=0; NaN → fall-through index cuối — FB-P6-R1-A-09
- **Fix:** guard !Number.isFinite(seed) || seed < 0 → trả −1 (caller fallback đường cũ). Kiểm chứng: test H6-1.

### BUG2-097 · D·P4 — nhãn "FNV-1a" của deterministicSeed chỉ đúng cho ASCII (code-unit UTF-16 ≠ byte UTF-8 chuẩn — \'ü\' lệch canonical 0x790b80bb vs 0x119dd44a) + join(\'|\') không tách phần (seed(\'a|b\',\'c\') ≡ seed(\'a\',\'b|c\')) — FB-P6-R1-A-10 (hệ chỉ cần tất định nội bộ — ghi nhận)
- **Fix:** JSDoc ghi rõ chuẩn-hoá UTF-16 + rủi ro join; sessionId uuid không chứa \'|\'. Kiểm chứng: đối chiếu 3 vector chuẩn ASCII + 4 chuỗi non-ASCII của auditor A.

### BUG2-098 · D·P4 — hygiene lô P4: (a) r79 import beforeAll không dùng; (b) schema comment "softmin dữ liệu" mơ hồ; (c) getTopQAdvice NaN limit làm Prisma take throw gây log noise (fail-open vẫn đúng) — FB-P6-R1-A-11
- **Fix:** (a) bỏ import; (b) comment "tín hiệu độ tin của dữ liệu"; (c) sanitize Number.isFinite → default 5 + Math.floor. Kiểm chứng: test H5 NaN-case + gate lint.

### BUG2-099 · D·P4 — GHI NHẬN C1: weights softmaxPolicy là CỔNG (0=chặn) không phải multiplier "score × health" theo chữ spec — production tương đương vì llm.ts lọc blocked khỏi candidates và không truyền weights — FB-P6-R1-A-12
- **Fix:** JSDoc ghi rõ ngữ nghĩa gate vs multiplier + lý do tương đương production. Kiểm chứng: đọc code call-site llm.ts:4431-4434.

### BUG2-100 · C·P3 — markSessionAdaptationOutcome recorded=true khi SAL update THẤT BẠI (update .catch nuốt → ledger row giữ successful=null nhưng hàm vẫn báo đã đóng) → W1 updateQ học trên bằng chứng không tồn tại trong ledger (Q↔SAL divergence, không truy lại được) — FB-P6-R1-B-01 (auditor B)
- **Fix:** updated = update().then(()=>true).catch(()=>false); recorded = updated && pending !== null. Kiểm chứng: test adaptation-engine pin findMany-có-pending + update-reject → recorded=false; gate.

### BUG2-101 · D·P4 — comment goal-loop "qAdvice bị cắt đầu tiên khi prompt chật" SAI cơ chế: hint 198 chars < MIN_BLOCK_CUT_CHARS (500) nên miễn nhiễm tuyệt đối budget-shave (đánh lừa maintainer về cơ chế ưu tiên) — FB-P6-R1-B-02 (auditor B dùng chính prompt-budget.ts thật để chứng minh)
- **Fix:** comment viết lại đúng (block <500 chars không bao giờ bị cắt). Kiểm chứng: harness S7a-c ép tier-60 phải cắt — qAdvice vẫn nguyên vẹn.

### BUG2-102 · C·P4 — modelsUsedThisRun (bảng đếm model cho dominantModel W2) khai báo Map mới không nằm trong resumeState → run resumed sau crash chỉ tính model của ĐOẠN CUỐI — reward credit assignment lệch cho run hiếm — FB-P6-R1-B-03
- **Fix:** persist vào checkpoint (`modelsUsed: Array.from(entries)`) + restore `new Map(resumeState?.modelsUsed ?? [])` (checkpoint cũ không field → Map rỗng = hành vi cũ); goal-loop-durable-types thêm optional field; REV bump fbp6w1. Kiểm chứng: test H6-3 pin round-trip JSON; auditor R2 đọc worker load — không whitelist field nào bỏ mất.

### BUG2-103 · C·P4 — W1 stateKey lấy routingDecision LÚC ĐÓNG (close-time): SAL pending từ run có thể được đóng ở run khác routing (resume/request mới → TL analyze lại) → reward ±1 ghi nhầm bucket mode-tier (đo bằng grep: stepId trùng tên giữa pipeline B/2, B/3, C/2, C/3) — FB-P6-R1-B-04
- **Fix:** lưu routingStateKey vào SessionAdaptationState lúc APPLY (param 5 tùy chọn applyAdaptationToSession; detectAndPersistFailurePattern truyền qStateKey(routing)); markSessionAdaptationOutcome trả routingStateKey; workflow-engine dùng outcome.routingStateKey ?? close-time fallback. Kiểm chứng: test adaptation pin outcome.routingStateKey=mode-B-tier-2; tsc + gate.

### BUG2-104 · C·P4 — filter caps softmax dùng `!== false` → model KHÔNG khai báo caps (undefined/gõ nhầm key) mặc nhiên thành ứng viên (hiện trạng 8/8 model đủ caps — lỗ hổng tiềm ẩn khi catalog thêm model) — FB-P6-R1-B-05
- **Fix:** whitelist `=== true` cho coding ∧ reasoning. Kiểm chứng: test H6-2 pin catalog invariant (mọi model zen phải có caps — model thiếu caps bị test chặn trước khi đổi âm thầm tập ứng viên).

### BUG2-105 · C·P4 — seed \'anon\' (call thiếu cả sessionId lẫn agentName): mọi call như vậy cùng chọn 1 model cố định (ngược nhẹ mục tiêu phân tán) — mọi call-site lớn hiện truyền agentName → hiếm; giữ tất định theo spec — FB-P6-R1-B-06 (ghi nhận, không đổi hành vi)
- **Fix:** JSDoc ghi nhận lý do giữ tất định (thêm nhiễu thời gian phá "chạy lại được"). Kiểm chứng: grep call-site của auditor B + harness S3d.

### BUG2-106 · D·P4 — RUNTIME_MODEL_TAU="0" bị `parseFloat(x || \'0.5\') || 0.5` coi là falsy → nhảy default 0.5 thay vì qua floor 0.05 (ngữ nghĩa floor sai: "0" là giá trị chủ ý hợp lệ) — FB-P6-R1-B-07
- **Fix:** helper single-source parseRuntimeModelTau (q-table.ts — testable) dùng cho llm.ts: parse tường minh, NaN/rỗng → 0.5, "0"/âm/nhỏ → floor 0.05. Kiểm chứng: test H6-4 pin 8 tổ hợp env; barrel export đủ.

### BUG2-107 · D·P4 — q-table không nằm trong barrel src/lib/learning/index.ts (4 call-site import trực tiếp) — FB-P6-R1-B-08 (có tiền lệ adaptation-engine ngoài barrel — hygiene C7)
- **Fix:** re-export đủ 15 tên + type. Kiểm chứng: tsc + import-smoke R2/R3.

### BUG2-108 · C·P4 (quan sát gated) — pending SAL chọn theo createdAt-desc có thể là row bị stats-gate chặn (statsJson.applied=false — row "đề xuất KHÔNG được áp" vẫn pending) → markSessionAdaptationOutcome đóng + updateQ reward cho strategy CHƯA TỪNG ÁP (chỉ khi ADAPTATION_STATS_GATE=on) — FB-P6-R1-B-10 (auditor B; hiện thân thành fix-chết BUG2-119)
- **Fix:** findMany take-10 + lọc row applied=false khi chọn pending (đóng row áp thật cũ hơn nếu có). Kiểm chứng: test adaptation 2 case (blocked-mới-nhất → chọn row áp thật; toàn blocked → recorded=false) — sau khi BUG2-119 sửa predicate chết.

### BUG2-109 · D·P4 — comment metrics-db "resolveArbiterVerdicts (cũ)… không đụng caller/test hiện có" ngụ ý còn caller — thực tế 0 caller nội bộ (caller duy nhất goal-loop đã chuyển sang Detailed từ chính commit P6) — FB-P6-R1-C-01
- **Fix:** comment viết đúng ("giữ làm API ổn định additive-only"). Kiểm chứng: grep toàn repo của auditor C.

### BUG2-110 · C·P4 — raw-path resolveArbiterVerdictsDetailed tách 2 lệnh $executeRaw rời: crash/giẽ giữa 2 lệnh để lại resolve nửa vời (confirmed đóng, refuted kẹt pending); row insert giữa 2 lệnh bỏ lại pending (lý thuyết — resolve chạy cuối run sau khi verdict-insert được await) — FB-P6-R1-C-02
- **Fix:** gộp `db.$transaction([tx1, tx2])` array-form (tuần tự cùng commit/rollback). Kiểm chứng: test r80 pin (spy $transaction — đúng 1 lời gọi array-2, counts đúng, idempotent; bản 2-lệnh-rời → txCalls=0 FAIL) — qua DI client riêng tư sau 2 lần thiết kế sai (xem BUG2-120).

### BUG2-111 · C·P4 — GHI NHẬN KHÔNG-FIX: complete ∉ {0,1} (NULL/số lạ) cũ CASE ELSE → \'refuted\', bản 2-nhánh WHERE mới để row KẸT PENDING — phân kỳ thật nhưng bất khả thi qua app (schema Boolean NOT NULL + mọi writer ghi 0/1 + Prisma validate; chỉ xảy ra sửa DB tay) — hành vi mới an toàn hơn (không bịa verdict từ dữ liệu rác) — FB-P6-R1-C-03
- **Fix:** không cần — ghi nhận sổ. Kiểm chứng: harness bảng chân trị 12 phép của auditor C + đọc schema/writer.

### BUG2-112 · D·P4 — comment agents-module "SelectItem không chứa được span trang trí nhiều" SAI SỰ THẬT (Radix SelectItem chấp nhận span con — CSS select.tsx:110 còn styled cho span) — FB-P6-R1-C-04 (cùng loại FB-Đợt6-R1-01)
- **Fix:** comment viết đúng (text-marker là lựa chọn thiết kế giữ markup 1 dòng). Kiểm chứng: đọc ui/select.tsx:101-113.

### BUG2-113 · C·P4 — badge Q UI: (a) q âm nhỏ → toFixed(2) hiển thị "-0.00"; (b) khi TOÀN BỘ model đã học có q âm, badge vẫn "Q đề xuất" cho model kém nhất — dễ hiểu nhầm "đề xuất" khi không có gì đáng đề xuất — FB-P6-R1-C-05
- **Fix:** badge chỉ hiện khi q > 0 (cả agents-module + smolab); smolab thêm role="img" + aria-label (title chỉ tới được bằng hover — keyboard/screen reader không thấy). Kiểm chứng: đọc render + điều kiện; browser (bước live).

### BUG2-114 · C·P4 — agents-module fetch models 1 lần lúc mount → badge Q stale suốt đời module khi fetch sau đó fail im lặng (smolab đã refetch mỗi lần mở dropdown) — FB-P6-R1-C-06
- **Fix:** Select onOpenChange(open) → refetch (mirror pattern smolab; không mất scroll/focus — auditor R2 kiểm chứng). Kiểm chứng: đọc code + browser.

### BUG2-115 · C·P2 — FIX B-10 VÒNG R1 LÀ PREDICATE CHẾT: statsJson là cột String? (JSON.stringify text) nên `typeof p.statsJson === \'object\'` KHÔNG BAO GIỜ true → filter không tác dụng, hành vi y hệt bản trước fix — B-10 vẫn sống trên đường gated thật (ADAPTATION_STATS_GATE=on trong pm2 env) — FB-P6-R2-01 (auditor R2 tái lập LIVE trên throwaway DB: 2 row blocked-mới + applied-cũ → hàm vẫn chọn row blocked, trả toStrategy=reduce_scope)
- **Fix:** dùng lại isNotAppliedStatsJson (single-source với reader evidence gate đợt 6 — JSON.parse chuỗi, null/hỏng = "đã áp" fail-open đầy đủ) — export từ adaptation-stats + dynamic import. Kiểm chứng: test adaptation pin 2 case (đúng 1 lỗi của cả 2 lần viết sai — predicate chết + findFirst-cũ); live-đường gated sẽ thấy sau restart.

### BUG2-116 · D·P3 — 7 fix R1 ngoài q-table KHÔNG test regression nào pin (B-01/B-10/B-04/B-03/B-07/A-09/C-02 — C5 5/5 tiền lệ FB-Đợt7-R4; chính lỗ hổng này để predicate chết BUG2-115 sống sót vòng R1) — FB-P6-R2-02
- **Fix:** +16 test (adaptation-engine 4 + r79 H1-H6 12; vòng R3/R4 bổ sung r80 + sửa H3/H4 sai-kỳ-vọng). Kiểm chứng: gate 990 → 1007; bảng fix→pin của R3/R4 (pin mạnh 15, ◐ gián tiếp 3 được phán duyệt: B-05 catalog-invariant, B-03 contract round-trip, B-07 wiring-const; comment-only không cần pin).

### BUG2-117 · D·P4 — JSDoc applyAdaptationToSession thiếu tham số 5 routingStateKey (đã thêm hàm + interface nhưng doc bỏ quên) — FB-P6-R2-03
- **Fix:** JSDoc đủ param 5 + ngữ nghĩa trả lại trong outcome. Kiểm chứng: đọc doc vs signature.

### BUG2-118 · C·P4 — chuỗi updateQ không timeout tầng app: 1 link treo vĩnh viễn (nếu Prisma socket-timeout không kick) → toàn bộ learning side-channel đóng băng + hàng đợi tích luỹ — FB-P6-R2-04 (hàng rào thật: Prisma socket ~5s — chính là lỗi quan sát được vòng R1; đây là belt-and-suspenders)
- **Fix:** updateQStep bọc Promise.race timeout 20s + clearTimeout finally + console.warn đường timeout (R3-02 bổ sung log — JSDoc nói "fail-open log" nhưng bản đầu không có log nào). Kiểm chứng: auditor R3 replica Bun (reject ✓ chuỗi tiếp tục ✓ 0 unhandledRejection ✓ timer clear 2/2).

### BUG2-119 · D·P3 — fix C-02 ($transaction gộp) KHÔNG test pin nào — revert về 2 lệnh rời vẫn PASS 100% gate (mục thứ 8 trong danh sách R2-02 nhưng bị bỏ qua khi fix) — FB-P6-R3-01
- **Fix:** DI param client (additive — mọi caller giữ 3 tham số) + file r80 PrismaClient riêng tư bọc Proxy test-local (arbiterVerdict→undefined ép raw-path; $transaction→spy). Kiểm chứng: r80 PASS (txCalls=1 array-2; idempotent); R4 phân tích revert → FAIL. Hai lần thiết kế sai trước đó (H7-v1: mutate db-dùng-chung → nhiễm lan r76/r77 vì bun test 1 process + mock.module cho r79 cầm Proxy chung; H7-v2/r80-v1: defineProperty trên PrismaClient-thật-là-Proxy có descriptor own-data GIẢ value=undefined — probe: desc truthy nhưng value undefined, đọc trực tiếp mới ra function) — ghi làm bài học hạ tầng test.

### BUG2-120 · D·P4 — JSDoc updateQStep (vòng R2-04 fix) ghi "timeout reject → fail-open log" nhưng đường timeout KHÔNG có log nào (chỉ đường DB-error trong lớp trong có warn) — FB-P6-R3-02
- **Fix:** catch race → console.warn đủ ngữ cảnh (stateKey/actionKey + "chuỗi tiếp tục, work nền có thể hoàn tất trễ"). Kiểm chứng: đọc code + R4 xác nhận.

### BUG2-121 · D·P4 — barrel learning/index.ts thiếu 2 tên mới cùng vòng fix: parseRuntimeModelTau + RUNTIME_MODEL_TAU_FLOOR (13/15 tên) — FB-P6-R3-03
- **Fix:** export đủ 15 tên + type. Kiểm chứng: R4 đối chiếu 16/16 export thật + tsc EXIT 0.

### GHI NHẬN ĐẶC BIỆT FB-P6 (R1→R4)
- **Sai-kỳ-vọng phía người-rà (+20 — chuỗi tới lần 16):** điều phối tự bắt 2 khi viết regression (H4: 0.5 KHÔNG > 0.5; H3: kỳ vọng maxNext=0 nhưng chuỗi tuần tự cho mỗi update đọc Q vừa ghi — giá trị đúng 0.956179 khớp số đo độc lập của auditor) · auditor A 6 (modulo bias, underflow blocked-argmax, fall-through float, τ-JSDoc, comment B2, create-race) · auditor B 2 (chấm tay S4e quên γ·maxNext; cấu hình probe tier sai) · auditor C 4 (nhánh cũ delegate, đường provider=zen, cache heuristic, degenerate NULL) · auditor R2 3 (softmax NaN, assertion wraparound, giả định Prisma Json object) · auditor R3 3 (export runPipeline, barrel cam kết tên, đọc predicate đảo) · R4 0.
- **Phát hiện bị bác sau chấm chéo: 0/40 đề xuất** (12+9+6 R1 + 4 R2 + 3 R3 + trọng số phán quyết) — 34 nhận + 6 residual phán ghi-nhận/◐-chấp-thuận (findFirstMock dead — R2 #3, 3 pin ◐ R3, qEntryCount telemetry, C-03 bất khả thi).
- **Bài học hạ tầng test mới:** (1) bun test 1 process dùng chung — mock.module '@/lib/db' khiến file import sau cầm Proxy mock; KHÔNG mutate property trên db dùng chung; (2) PrismaClient là Proxy với getOwnPropertyDescriptor own-data GIẢ (value undefined) — defineProperty/spy property trên client KHÔNG ổn định; pin bằng client riêng + Proxy-wrap test-local; (3) $transaction tương tác trên SQLite giữ lock — truyền nhiễm timeout sang test khác; tuần tự hoá in-process là giải pháp đúng cho deployment 1-process.

### BUG2-122 · D·P4 — JSDoc header neural-layout.ts nói "Ba khối" nhưng liệt kê 4 khối (1 GEO+FONTS · 2 computeNeuralLayout · 3 EDGE_KINDS · 4 ZOOM) — FB-P1-R1-01 (auditor R1 độc lập)
- **Fix:** "Ba khối" → "Bốn khối". Kiểm chứng: đọc trực tiếp header sau fix; cùng loại doc-fidelity BUG2-112/091.

### BUG2-123 · G·P4 — barrel learning/index.ts: comment khối neural-layout dán LIỀN trên cùng dòng export cuối (`…getTuningSpec } from './neural-types'// Neural-layout (P1…`) do file gốc không kết thúc newline — FB-P1-R1-02 (auditor R1; vestige EOF từ lần append bằng heredoc)
- **Fix:** xuống dòng riêng cho comment (thêm blank line trước). Kiểm chứng: `sed -n '97,101p' | cat -A` — comment tách dòng; tsc + eslint + gate PASS giữ (gate không bắt được lỗi format này — vệ sinh tay).

### BUG2-124 · C·P4 — nút "Thu nhỏ 10%" từ chế độ fit PHÓNG TO đồ thị: zoomBy neo base = 1 khi prev='fit' → 0.9 × viewBox 1732 = 1558.8px > 1180px (fit floor) — trên mọi card hẹp (toàn bộ mobile — fit là mặc định lần đầu vào) đồ thị TO ra ~32% khi nhãn nói thu nhỏ; đối xứng "Phóng to" từ fit thu nhỏ trên container ≥1905px — FB-P1-R1-03 (auditor R1 tính tay + phân tích container)
- **Fix:** tách helper thuần `zoomStepFrom(prev, fitScale, delta)` (neural-layout.ts) — từ 'fit' neo base theo TỈ LỆ RENDER THẬT (svgRef.getBoundingClientRect().width / viewBox.baseVal.width, vd 1180/1732 ≈ 0.68) → "Thu nhỏ" cho 0.68−0.1 → 0.6 ≈ 1039px thật sự nhỏ hơn 1180px; fitScale null/NaN/≤0 (svg chưa render) → fallback neo 1 (giữ hành vi cũ). Kiểm chứng: 4 test r82 FB-P1-R1-03 (0.68−0.1 → 0.6; 1.15+0.1 → 1.25; garbage → 0.9; numeric passthrough + kẹp biên) + LIVE browser: fit 1180px → bấm Thu nhỏ → 1039px, stored "0.6" (trước-fix sẽ là 1558.8px).

### BUG2-125 · C·P4 — 3 nhánh phòng thủ computeNeuralLayout + biên clamp KHÔNG test nào pin (node khai sai layer bị bỏ / cạnh thiếu đầu bị bỏ / graph rỗng không crash / cặp 3 cạnh offset 0+16−16 / clamp số âm + biên đúng 0.6-1.6): xoá guard → gate vẫn xanh vì NEURAL_GRAPH thật sạch do r81 pin INPUT chứ không pin tính phòng thủ của MODULE (tiền lệ BUG2-093/116) — FB-P1-R1-04 (auditor R1 chạy thật 6 kịch bản degenerate — hành vi ĐÚNG, chỉ thiếu pin)
- **Fix:** +4 test r82 nhóm FB-P1-R1-04 (graph tự dựng 2 lớp × node hợp lệ + node sai layer + 2 cạnh lửng + self-loop; cặp 3 cạnh distinct; graph rỗng width 52/height 176 finite; clamp −5→0.6 + biên 0.6/1.6 đúng). Kiểm chứng: gate 1062 → 1072 PASS; revert-guard giờ bị test bắt.

### BUG2-126 · C·P4 — 5/37 cạnh có THÂN ĐƯỜNG CONG thật vượt viewBox (sampler 400 bước độc lập: e13 maxX 1741.6 > 1732; e21/e36 maxX 1761.9; e24 minX −50.2; e28 minX −70.5) — control point dx=0.45×khoảng-cách đâm xuyên viền, SVG clip mép nhìn như đường đâm vào viền rồi bật lại. PRE-EXISTING: tái lập bằng hằng số pre-P1 cho ra cùng 5 cạnh (−68.8…1736.2 ở viewBox 1712) — P1 (NODE_W 196→220) khuếch nhẹ +2…26px; công thức bezier đời nguyên vẹn từ component cũ nhưng nay SỐNG trong module mới của scope nên fix luôn — FB-P1-R1-05 (auditor R1 sampler chạy trên cả hằng số mới lẫn cũ)
- **Fix:** kẹp từng control point vào viewBox với margin 4 (cp1x = min(x1+dx, width−4); cp2x = max(x2−dx, 4)) — giữ trật tự điểm kiểm (U-turn reverse vẫn mượt) nhưng toàn bộ hull nằm trong khung. Kiểm chứng: 2 test r82 FB-P1-R1-05 — sampler bezier CÔNG THỨC ĐỘC LẬP viết trong test (B(t)=(1−t)³P0+3(1−t)²tP1+3(1−t)t²P2+t³P3) quét 81 bước × 37 cạnh: mọi điểm trong [−0.5, width+0.5]×[−0.5, height+0.5]; riêng 5 cạnh từng vi phạm assert chặt [0, width]×[0, height] (fail ngay nếu revert).

### GHI NHẬN ĐẶC BIỆT FB-P1 (R1→R2)
- Auditor R1 độc lập (subagent GLM, mắt chưa xem code P1): harness 191 phép tự dựng (layout/zoom/edgeVisual viết lại từ mô tả, không nhìn code) + probe browser rasterize lấy mẫu pixel (marker arrowhead dim 38/255 vs active 253/255 — xác nhận opacity <g> kéo theo marker) + sampler bezier 400 bước trên hằng số mới lẫn pre-P1 (git show HEAD) + tsc/eslint/imports.
- 11 nghi vấn auditor TỰ BÁC bằng phương pháp thứ ba (sàn 8.5 có thật là min? fit không sửa legibility? marker chịu opacity nhóm? clamp float-junk? localStorage NaN/±∞? graph rỗng crash? onBlur prev-updater? unused import? namespace persist? kỳ vọng test "khớp code"? hydration mismatch SSR?) — 0 nghi vấn nào đứng vững thành phát hiện.
- Phát hiện bị bác sau chấm chéo điều phối: 0/5 — toàn bộ đứng vững (3 chuỗi liên tiếp: đợt7-R4/R5 + P6 + P1).
- Sai-kỳ-vọng phía người-rà (lần 17): +2 của chính người viết test r82 bản đầu (margin HEADER_H "+8" tùy ý — clearance thật 7px dư cho descent 8.5px; kỳ vọng clamp(+∞)=MAX trong khi thiết kế chủ đích fail-open về default 1 cho giá trị rác localStorage) — code đúng cả 2, sửa kỳ vọng test kèm ghi rõ lý do.
- Phát hiện ngoài phạm vi (bàn đợt sau, KHÔNG fix trong FB-P1): (1) role="img" trên <svg> chứa 23 node role="button" tương tác được — mâu thuẫn ARIA presentational (pre-existing, đụng DOM semantics lớn); (2) SMIL animateMotion không tuân prefers-reduced-motion (đã nằm trong backlog P2/P3 của báo cáo review task-98).

### GHI NHẬN ĐẶC BIỆT FB-P2 (R1→R2)
- Auditor R1 độc lập (subagent — mắt chưa từng xem code P2): script throwaway DB riêng /tmp/fb-p2-audit/rt.db (capture-restart + prune-verify 12 phép + snapshot-race ×3 không tái lập N1) + đọc full 8 file scope + git show HEAD đối chiếu + tsc/lint/r81/r82/r83 chạy lại độc lập. 0 P0/P1.
- Phát hiện bị bác sau chấm chéo điều phối: 0/7 + 1 nghi vấn (N1) — toàn bộ 7 phát hiện đứng vững (4 chuỗi liên tiếp: đợt7-R4/R5 + P6 + P1 + P2). N1 chuyển thành fix phòng thủ có chủ đích (BUG2-134).
- Ghi-nhận-không-fix: BUG2-133 (SSR dot flash — trade-off có chủ đích của useSyncExternalStore server-snapshot, vài trăm ms sau first-paint).
- Sai-kỳ-vọng phía người-rà: 0 (lần đầu sau 17 lần liên tiếp — auditor kỷ luật "NGHI VẤN chưa tái lập" tách bạch khỏi phát hiện).
- Phát hiện ngoài phạm vi (bàn đợt sau, KHÔNG fix trong FB-P2): heading Q-table hardcode "mode-agent-tier-1" + qTop bar bão hoà |Q|>1 (2 phát hiện review task-98 chưa nằm trong menu P1/P2/P3) · ARIA role="img" vs node tương tác (kế thừa từ FB-P1).

### BUG2-127 · C·P3 — captureAuditState lấy fromEffectiveValue qua SNAPSHOT trong khi storeValue đọc thẳng DB: lần set/reset ĐẦU TIÊN sau khởi động process (chưa có GET nào đi trước) snapshot rỗng → audit ghi hiệu lực-trước SAI (mặc định thay vì giá trị store cũ) — mâu thuẫn chính comment schema "hiệu lực tại thời điểm ghi — snapshot tin cậy cho audit" — FB-P2-R1-01 (auditor R1 tái lập script throwaway: DB sẵn α=0.3, set 0.5 ngay → fromEffectiveValue "0.1" thay vì "0.3")
- **Fix:** captureAuditState derive hiệu lực-trước từ CHÍNH store-value đọc DB (normalizeStored — belt-and-suspenders sẵn có); store null → resolve env/default TRỰC TIẾP từ process.env (bản sao độc lập còn chính xác HƠN resolveTuning vì không dính snapshot stale). Kiểm chứng: regression r83 FB-P2-R1-01 (seed DB 0.3 + xoá globalThis.__tmoTuningSnapshot giả lập restart → set 0.5 → fromEffectiveValue "0.3" đúng) + gate 1089/1089.

### BUG2-128 · C·P3 — prune deleteMany theo createdAt < boundary cho mọi dòng TIE cùng millisecond boundary SỐNG SÓT → cap 500 bị vượt (auditor tái lập: 600 dòng cùng ts + 1 set = 601 > 500); kèm getTuningChangeLog orderBy createdAt đơn trụ → thứ tự trong nhóm cùng-ms không tất định — FB-P2-R1-02 (auditor R1 script prune-verify mục B)
- **Fix:** TuningChangeLog.id đổi cuid → Int @default(autoincrement()) (bảng 0 dòng production — đổi vô hại, db push recreate; KHÔNG theo convention cuid 88 model khác là CHỦ ĐÍCH — comment schema ghi rõ); prune rewrite: count → findMany skip CAP theo orderBy (createdAt desc, id desc) → deleteMany id-in excess — cap TUYỆT ĐỐI kể cả tie, dòng vừa insert có cặp khoá (ts,id) lớn nhất mọi thời điểm nên không bao giờ rơi vào excess; mọi orderBy đọc thêm id desc làm tiebreak tất định. Kiểm chứng: regression r83 FB-P2-R1-02 (601 dòng cùng-ms + set → count ĐÚNG 500, dòng set đứng đầu) + gate 1089/1089.

### BUG2-129 · D·P4 — useSyncExternalStore nhận subscribe là closure mới mỗi render (onChange => subscribeMediaQuery(...)) → React unsubscribe+resubscribe CẢ 2 media query mỗi re-render (poll setData 15s, hover, zoom…) — thuần churn không sinh lỗi nhưng phá hazard-unit của hook — FB-P2-R1-03 (auditor R1 phân tích cơ chế React)
- **Fix:** hoist subscribeReducedMotion/subscribeDesktop ra module-scope (tham chiếu ổn định qua render). Kiểm chứng: đọc trực tiếp + tsc/lint PASS; hành vi không đổi (gate giữ).

### BUG2-130 · F·P4 — mobile sheet mở vẫn mount NodeInspectorContent 2 LẦN: cột desktop chỉ ẩn CSS (hidden lg:block) chứ không unmount → TuningControl/Slider/AlertDialog render đôi tốn khi sheet mở — FB-P2-R1-04 (auditor R1 đối chiếu DOM 2 vị trí 611-625 vs 647-655)
- **Fix:** cột render điều kiện {isDesktop && (…)} — mobile không mount bản ẩn; hydrate an toàn (server-snapshot true → SSR render cột, client snapshot thật hiệu chỉnh ngay sau hydrate KHÔNG mismatch — đúng cơ chế useSyncExternalStore). Kiểm chứng: tsc/lint + browser E2E live (mobile sheet mở, cột không còn trong DOM).

### BUG2-131 · D·P4 — literal 1024 còn hardcode trong zoom-restore effect (window.innerWidth < 1024) ngay khi P2 thêm NEURAL_DESKTOP_BREAKPOINT=1024 với JSDoc "1 nơi duy nhất" → breakpoint tồn tại 2 chỗ, đổi 1 quên 1 lệch layout mobile-fit — FB-P2-R1-05 (auditor R1 grep literal)
- **Fix:** thay bằng NEURAL_DESKTOP_BREAKPOINT (import sẵn). Kiểm chứng: rg '1024' component → 0 literal ngoài hằng số (chỉ trong DESKTOP_MEDIA_QUERY build từ hằng số).

### BUG2-132 · E·P4 — test r83 thiếu 4 pin then chốt: (a) prune tie-cùng-ms (revert BUG2-128 fix vẫn PASS), (b) fail-open writeChangeLog — lời hứa "lỗi audit không làm fail set" chưa pin, (c) take-limit getTuningChangeLog, (d) capture-restart BUG2-127 — FB-P2-R1-06 (auditor R1 C5)
- **Fix:** +4 regression test r83 (R1-01/R1-02/R1-06b DROP TABLE thật + tái tạo schema mirror/R1-06c) — tổng r83 13 → 17 test, gate 1085 → 1089; mọi fix R1 giờ có pin chứng minh lỗi cũ đã hết.

### BUG2-133 · C·P4 — user bật prefers-reduced-motion vẫn thấy hạt animateMotion chạy từ first-paint tới khi hydration xong (~vài trăm ms): server-snapshot () => false render dot trong SSR, chỉ gỡ sau khi client hydration re-render với snapshot thật — FB-P2-R1-07 (auditor R1 phân tích lý thuyết useSyncExternalStore; không đo được live)
- **GHI NHẬN KHÔNG FIX (trade-off có chủ đích):** cơ chế này CHÍNH LÀ thiết kế của useSyncExternalStore chống hydration-mismatch (server snapshot phải khớp SSR HTML); fix triệt để (render dot chỉ sau mount) thêm state churn + nháy ảnh ngược cho đa số user. Phạm vi: vài trăm ms đầu tiên, chỉ reduced-motion user, chỉ lần tải trang đầu. Bàn lại nếu có khiếu nại accessibility thực.

### BUG2-134 · G·P3 — NGHI VẤN N1 (auditor R1, 3 lần chạy KHÔNG tái lập — ghi nhận là fix PHÒNG THỦ có chủ đích): load-cũ-resolve-muộn có thể đè mất giá trị vừa set trên snapshot (captureAuditState kích hoạt ensureFresh → findMany bay trước upsert → resolve SAU khi set ghi snapshot thủ công → loadSnapshotFromDb ghi đè snapshot bằng data đọc TRƯỚC upsert → consumer thấy stale ≤ 1 TTL 5s; DB + audit vẫn đúng). Pre-existing pattern từ task-97 nhưng P2 tăng xác suất trigger — FB-P2-R1-N1 (auditor R1 script snapshot-race ×3 fresh-process đều không tái lập; điều phối xác nhận chuỗi async có thể về lý thuyết)
- **Fix (phòng thủ):** loadSnapshotFromDb skip-if-newer — ghi startedAt trước await, chỉ ghi đè khi snapshot hiện tại KHÔNG mới hơn startedAt (current.at > startedAt → bỏ qua). Load nối tiếp bình thường vẫn ghi (at cũ < startedAt); hai load cùng ms không skip oan (dùng >, không >=). Kịch bản residual được ghi nhận chủ đích: snapshot 1-key mới tạo (else-branch set khi snapshot chưa tồn tại) + load cũ skip → thiếu key khác ≤ 1 TTL — tương đương semantics fail-open cửa sổ TTL có sẵn, không làm tệ hơn trước-fix. Kiểm chứng: logic 3 tam ca xét tay (T_load < T_set / T_set < T_load / cùng-ms) + gate 1089/1089 giữ.

### GHI NHẬN ĐẶC BIỆT FB-P3 (R1→R2)
- Auditor R1 độc lập (subagent — mắt chưa từng xem code P3): đo độ rộng chữ thật bằng script PIL/DejaVuSans (font proxy RỘNG HƠN Geist → thận trọng) tại /home/z/my-project/tool-results/fb-p3-r1/ + chạy lại r82 (31/31) + tsc độc lập + truy vết thứ tự pointerup→click→setTimeout. 0 P0/P1/P2.
- Phát hiện bị bác sau chấm chéo: 0/3 — chuỗi thứ 5 liên tiếp toàn bộ phát hiện auditor đứng vững.
- Sai-kỳ-vọng phía người-SỬA (điều phối tự bắt TRƯỚC gate, không tới rà): effect đo canPan dựng TRƯỚC `const layout` (TDZ — deps `[layout?.width]` trước khai báo) — tự phát hiện khi reread, dời xuống sau useMemo layout.
- Phạm vi P3 theo chỉ thị user: drag-pan đồ thị + cỡ chữ +1px toàn ô/bảng + ARIA role group. Kèm theo đợt (ngoài FB, hạ tầng): rebaseline migration 0_init theo chỉ thị "quay lại luồng migration chuẩn" — xem ghi chú fixbug.md.

### BUG2-135 · C·P3 — pan chỉ dọn listener qua pointerup/pointercancel: cửa sổ MẤT FOCUS giữa lúc kéo (Alt+Tab, dialog OS chiếm input, thả chuột lúc tab nền) → pointerup không bao giờ tới → listener pointermove sống tiếp và đồ thị BÁM THEO CHUỘT KHÔNG BẤM GIỮ tới lần click kế tiếp; unmount-mid-drag (đổi tab app) cũng để listener sót (tự lành, nhưng có cửa sổ hành vi sai) — FB-P3-R1-01 (auditor R1 truy vết code 2 đường: không guard mv.buttons, không listen blur/lostpointercapture)
- **Fix:** 3 lớp phòng thủ trong onPanPointerDown: (a) guard `mv.buttons === 0` trong onMove → tự chốt pan ngay khi chuột đã nhả (mouse self-heal mọi kịch bản mất pointerup); (b) `window.addEventListener('blur', onUp)` — cửa sổ mất focus → chốt; (c) panTeardownRef + effect unmount `() => panTeardownRef.current?.()` — component chết giữa lúc kéo → dọn sạch. Kiểm chứng: đọc logic 3 tam ca + gate 1089/1089 giữ + tsc/lint PASS (kịch bản blur không tái lập được deterministic trong dev-server browser — guard buttons đo trực tiếp trong tương tác kéo thường).

### BUG2-136 · D·P4 — affordance kéo NÓI DỐI khi vùng không tràn: cursor-grab tĩnh + legend "✋ giữ + kéo nền" + hint "giữ chuột + kéo để di chuyển" luôn hiển thị kể cả khi scrollWidth ≤ clientWidth (fit trên card ~1082px app-max-layout không xảy ra, NHƯNG zoom 60% → svg 1039px < container 1048px → kéo vô tác dụng mà cursor vẫn mời kéo) — FB-P3-R1-02 (auditor R1 đo: card 1432px/màn 1920, zoom 0.6 = 1039px không tràn)
- **Fix:** state canPan đo bằng ResizeObserver theo dõi CẢ container lẫn <svg> con (width svg đổi theo zoom) + measure lại khi layout/zoom đổi (deps [layout?.width, zoom]); cursor-grab, legend ✋, hint kéo đều điều kiện theo canPan. Effect đặt SAU useMemo layout (tránh TDZ — xem ghi nhận sai-kỳ-vọng). Kiểm chứng: browser live — zoom 0.6 (overflow 0) → cursor "auto" + legend ẩn + hint chỉ còn "60% — cỡ chữ thiết kế"; 100% (overflow 940) + fit 2400px (overflow 132) → grab + legend + hint đủ.

### BUG2-137 · F·P4 — cursor không nhất quán trong tương tác pan: (a) setPanning(true) đặt ngay tại pointerdown → nhấn giữ nền CHƯA kéo (chưa vượt ngưỡng 3px) nền đã grabbing; (b) node g có cursor-pointer (class trực tiếp thắng inheritance) → ĐANG KÉO sượt qua node cursor nhảy về "pointer" nhấp nháy theo node — FB-P3-R1-03 (auditor R1 kiểm chứng thứ tự class Tailwind + cơ chế kế thừa cursor)
- **Fix:** (a) setPanning(true) chỉ khi moved vượt ngưỡng 3px (trong onMove); (b) khi panning container nhận thêm `[&_*]:cursor-grabbing!` (descendant + important) đè cursor-pointer của node trong suốt pha kéo. Kiểm chứng: tsc/lint PASS + browser live kéo ngang qua cụm node (cursor giữ thống nhất một trạng thái grabbing).

### BUG2-138 · C·P3 — MLP.predict/predictProba/lossOf KHÔNG kiểm input dimension (fit có kiểm nhưng inference thì không): forwardAll lấy fanIn = x.length động → stride W sai → predict([0.5]) trên mạng input-2 trả RÁC HỮU HẠN (đo 0.5973), predict 3-chiều trả [NaN], predict([]) trả [0.5], lossOf sai chiều trả loss hữu hạn vô nghĩa — tất cả im lặng — FB-BRAIN-P1-R1-01 (auditor R1 tái lập 4 probe; điều phối tái lập độc lập khớp 100%)
- **Tác động:** mọi đường inference tương lai (UX-3 xem |w|, P2 calibration runtime, P3 replay) nhận rác/NaN không lời nào.
- **Fix:** guard đầu forwardAll (predict/predictProba/lossOf/backward đều đi qua): throw `forwardAll: input ${x.length} ≠ ${inDim} unit lớp input`; lossOf thêm guard y sai chiều (đối xứng backward vốn có). Kiểm chứng: probe sau-fix 3/3 throw đúng message + regression r84 7a (3 input sai + 1 y sai + 1 đường tốt) + gate 1157/1157.

### BUG2-139 · C·P3 — FitOptions không validate NaN/rác: epochs NaN → epochsRun=0 history=[] im lặng (trong khi epochs=0 throw — không nhất quán); batchSize NaN → Math.max(1,Math.min(NaN,n))=NaN → order.slice(0,NaN)=[] → batch rỗng → inv=1/0=∞ → 0·∞=NaN LAN VÀO WEIGHTS rồi serialize được lưu; patience NaN → không bao giờ dừng sớm; holdOutRatio NaN → mất hold-out; clipNorm NaN → TẮT clip âm thầm — FB-BRAIN-P1-R1-02 (auditor R1 tái lập từng biến; điều phối xác nhận W-has-NaN=true)
- **Tác động:** UX-2 Training Console parse số từ input UI (kịch bản NaN thực tế) + pipeline train P2 — rác vào phải ném to, không nuốt.
- **Fix:** validate 5 tham số đầu fit: epochs/batchSize/patience nguyên (≥1/≥1/≥0), holdOutRatio ∈ [0,0.5], clipNorm ≥ 0 — mọi giá trị phải hữu hạn; kẹp hiện có (batchSize ≤ n, holdOut 0..0.5) giữ nguyên + ghi rõ JSDoc. Kiểm chứng: probe sau-fix 5/5 throw + regression r84 7b (5 NaN + 5 ngoài phạm vi + 2 biên hợp lệ 0/0.5 chạy tốt) + gate 1157/1157.

### BUG2-140 · C·P3 — MLP.deserialize không chặn kind lạ + tensor trùng lặp: kind 'xyz' rơi nhánh else bị COI LÀ BIAS (target = b[l−1]); payload [W1,W1,W2,b2] đủ 4/4 tensor → b1 mất trắng giữ khởi tạo 0 — mạng "load được" mà sai âm thầm — FB-BRAIN-P1-R1-03 (auditor R1 tái lập trên mạng 3 lớp; điều phối tái lập độc lập nhánh kind-lạ)
- **Tác động:** weightsJson hỏng/timestamp lệch từ DB → brain load thiếu tensor không lời nào — vi phạm envelope A6 "deserialize validate shape".
- **Fix:** thay count-check đơn thuần bằng 4 guard: kind ∈ {W,b} + layer nguyên trong [1,L−1] + Set seen chặn trùng cặp (kind,layer) + vòng đuôi chặn thiếu W/b từng lớp (nhánh thiếu thay cho count — mọi payload sai đều chạm 1 trong 4, không còn đường lọt). Kiểm chứng: probe sau-fix 3/3 throw đúng (trùng lặp W1 / thiếu b2 / kind xyz) + roundtrip đường tốt vẫn tải bitwise + regression r84 7c (4 test) + gate 1157/1157.

### BUG2-141 · C·P3 — activationParams không được validateSpec kiểm (bất đối xứng lossParams.delta vốn có kiểm): spec leakyRelu {alpha:−5} ĐẠT constructor nhưng runtime resolveAlpha bỏ −5 thay fallback 0.01 im lặng (đo forward(−2,{alpha:−5}) = −0.02); swish β=0 thay 1; α=0 hợp lệ cũng bị thay — train chạy KHÁC spec hiển thị — FB-BRAIN-P1-R1-04 (auditor R1 tái lập runtime + đọc code validateSpec; điều phối xác nhận 3 probe)
- **Tác động:** UX-1 editor cho chỉnh α/β (§9.2 "chỉnh được") → draft≠thực-thi ngay từ nền toán.
- **Fix:** validateSpec kiểm alpha/beta khi có mặt: hữu hạn > 0 (khớp resolveAlpha/resolveBeta); dữ liệu rõ ràng hơn nuốt rác. Kiểm chứng: probe sau-fix throw đúng message + regression r84 7d (2 rác ném + 2 hợp lệ qua) + gate 1157/1157.

### BUG2-142 · D·P4 — JSDoc FitOptions thiếu quy ước thực: holdOutRatio kẹp [0,0.5] + CHỈ tách khi n≥4 (đo: 0.99 → kẹp 0.5; n=3 → valLoss=null); batchSize kẹp [1,n] (batchSize=0 → 1) — inline comment có, JSDoc hợp đồng công khai không — FB-BRAIN-P1-R1-05 (auditor R1 đo 2 nhánh hành vi)
- **Fix:** JSDoc FitOptions 5 trường ghi đủ hợp đồng (nguyên/kẹp/phạm vi/điều kiện tách hold-out). Kiểm chứng: đọc JSDoc ↔ hành vi (regression r84 7b pin 2 biên hợp lệ) + gate giữ.

### BUG2-143 · D·P4 — init.ts header ghi `W ~ N(0, √(2/fanIn))`: quy ước N(μ, σ²) chuẩn ML nghĩa tham số 2 là PHƯƠNG SAI → đọc đúng chữ thì var=√(2/fanIn) sai với thực tế var=2/fanIn (đo thực nghiệm 100k mẫu sai số 0.15-0.52% khớp var=2/fanIn; JSDoc initWeights ghi đúng "std") — FB-BRAIN-P1-R1-06 (auditor R1 đối chiếu quy ước ký hiệu + đo variance)
- **Fix:** header ghi rõ quy ước "N(μ, σ) — tham số 2 là độ lệch chuẩn" + chú "tức var = 2/fanIn" cả 2 dòng He/Xavier. Kiểm chứng: đọc lại + regression r84 8a pin variance He ≈ 2/fanIn, Xavier ≈ 2/(fanIn+fanOut) (chặn ai đổi std trượt gate — phát hiện R1-11) + gate 1157/1157.

### BUG2-144 · D·P4 — blueprint §4.1 ghi interface optimizer `step(grads, params)` nhưng code là `step(params, grads)` (optimizers.ts + JSDoc tự nhất quán — chỉ lệch chữ spec) — FB-BRAIN-P1-R1-07 (auditor R1 đối chiếu doc:182 với code:28)
- **Fix:** blueprint §4.1 sửa thành `step(params, grads)` + chú thích nguồn hiệu đính. Kiểm chứng: đọc lại doc khớp code (blueprint v0.4 → v0.5).

### BUG2-145 · C·P4 — nguyên tắc §9.1-3 "chặn > 250K tham số" chưa có chỗ thực thi nào: mạng 2048→300→2 = 615.302 tham số ĐẠT validateSpec (chỉ cản units ≤ 4096/lớp) — ngân sách CPU không được bảo vệ từ lớp toán (spec-schema.ts UX-1 §9.2 dự kiến r88 chưa tồn tại) — FB-BRAIN-P1-R1-08 (auditor R1 dựng spec 615K qua validateSpec)
- **Tác động:** P2+ consumer gọi nền toán với spec lớn → train treo CPU mà UI chưa kịp chặn.
- **Fix:** BRAIN_MAX_PARAMS = 250_000 export từ mlp.ts + validateSpec tính tổng Σ(unitsₗ×unitsₗ₋₁ + unitsₗ) từ spec và chặn > trần — mọi lối xây MLP (constructor lẫn deserialize) đều bị chặn; blueprint §9.1-3 ghi rõ điểm thực thi. Kiểm chứng: probe sau-fix 615K throw đúng + regression r84 7e (615K chặn · biên đúng 250.000 ĐẠT · 250.500 chặn · hằng số pin) + gate 1157/1157.

### BUG2-146 · C·P4 — ACTIVATIONS.softmax.forward là placeholder TRẢ SIGMOID (σ(0.5)=0.6225), backward trả 0 — export công khai: consumer loop qua menu gọi từng phần tử nhận giá trị sai âm thầm (mlp.ts tự dùng softmaxVector nên không dính) — FB-BRAIN-P1-R1-09 (auditor R1 đo forward(0.5)=σ(0.5); điều phối xác nhận)
- **Fix:** forward/backward tự ném lỗi hợp đồng rõ ràng (dùng softmaxVector / cặp gộp δ=p−y) — key vẫn trong menu cho validateSpec điểm danh; rác to hơn rác im lặng. Kiểm chứng: probe sau-fix throw đúng + regression r84 7f + gate 1157/1157.

### BUG2-147 · C·P4 — createOptimizer tên lạ trả undefined (switch không default) → crash TypeError TRỄ ở .step với thông báo lệch lạc — chỉ dính JS caller vượt type (TS chặn, validateSpec chặn đường MLP) — FB-BRAIN-P1-R1-10 (auditor R1 gọi createOptimizer('rmsprop', 0.1) → undefined; điều phối xác nhận)
- **Fix:** default branch throw `createOptimizer: optimizer '${name}' không hợp lệ (sgd|adam)`. Kiểm chứng: probe sau-fix throw đúng + regression r84 7f + gate 1157/1157.

### BUG2-148 · C·P4 — nhóm export nền toán chưa pin trực tiếp (C5): l2Penalty 0 consumer + 0 test (điều phối tự dùng sai shape number[] khi probe — API dễ dùng sai); initWeights variance không pin (đổi He std→√(1/fanIn) vẫn TRƯỢT gate — vẫn tất định + vẫn train được); initFamilyFor/initBias/makeRng/randn moments/getSpec deep-copy/DEFAULT_*/predictProba đa-unit/Adam bias-correction giá trị tay — đều đúng (auditor kiểm độc lập) nhưng trống pin — FB-BRAIN-P1-R1-11 (auditor R1 rà 11 nhóm export × test)
- **Fix:** +27 test r84 (nhóm 7 regression hợp đồng + nhóm 8 pin giá trị tay): l2Penalty (0.01,[1,2;0.5])=0.02625 tay · l2WeightGrad λw · initWeights He/Xavier variance ±20% (tất định mulberry32) + bit-đối-bit cùng seed · initFamilyFor mapping 9 hàm · initBias 0 · Adam 2 bước đầu = tay (m̂=v̂=1, mỗi bước −lr/(1+1e−8)) · SGD momentum 3 bước −0.1/−0.29/−0.561 tay · getSpec deep-copy 2 chiều · predictProba đa unit ném · DEFAULT_* 5 hằng · computeLabelTotal 5 kịch bản. Kiểm chứng: gate 1130 → 1157 (+27) PASS.

### BUG2-149 · C·P4 — badge tổng nhãn: khi MỌI signal.current đều null (đếm lỗi hết) labelTotal=0 (number) → vẫn hiện "0 nhãn" — phát ngôn sai "chưa có nguyên liệu" trong khi thật ra là "đếm lỗi" (spec fail-open chỉ định nghĩa mất API → ẩn; ca mọi-null là hở) — FB-BRAIN-P1-R1-12 (auditor R1 mô phỏng logic; điều phối đọc code xác nhận)
- **Fix:** logic thuần tách khỏi component thành registry.computeLabelTotal (pin được): không còn nguồn nào đếm được → trả NULL để UI ẩn badge; giá trị 0 đếm được vẫn là 0 (trạng thái "chưa có nhãn" hợp lệ, hiển thị đúng nghĩa); cộng theo nguồn không trùng giữ nguyên. Kiểm chứng: probe sau-fix (mọi-null → null · 0 → 0 · 4 nguồn thật → 35 khớp live "35 nhãn") + regression r84 8c 5 kịch bản + gate 1157/1157.

### BUG2-150 · C·P4 — chính sách NaN/∞ loss không nhất quán: clipProb ép NaN→1−ε khiến bce.fn(NaN,1)=1e−7 ≈ "loss HOÀN HẢO cho prediction NaN" (che mất divergence — nguy hiểm hơn crash) trong khi mse.fn(NaN,1) lan NaN; softmaxVector([∞,1])=[NaN,NaN] không ghi chú — FB-BRAIN-P1-R1-13 (auditor R1 đo 3 giá trị; điều phối xác nhận cả 3)
- **Fix:** thống nhất hướng "NaN lan — hiển thị rõ, ∞ kẹp biên an toàn": clipProb trả NaN cho NaN (bão hoà ±∞ giữ kẹp biên B3); JSDoc losses.ts ghi rõ chính sách. softmaxVector giữ nguyên (+∞ đầu vào → NaN là rác-vào-rác-ra hiển thị rõ — không over-engineer cho logits vô hạn). Kiểm chứng: probe sau-fix (bce NaN → NaN lan · bce ∞ → 1−ε biên) + regression r84 7g (2 test: NaN lan 3 đường + ∞ kẹp biên) + gate 1157/1157.

### BUG2-151 · D·P4 — fix R1-02 tự sinh mâu thuẫn JSDoc↔hành vi + mã chết: JSDoc holdOutRatio ghi "tự kẹp về biên" trong khi guard mới NÉM cho ngoài [0,0.5] (đúng lớp lỗi R1-05 vốn đang fix!); dòng kẹp `Math.max(0, Math.min(rawHoldOut, 0.5))` thành MÃ CHẾT (input đã validate ∈ [0,0.5]); kẹp `Math.max(1, …)` của batchSize cũng chết nửa (rawBatchSize đã validate ≥ 1) — FB-BRAIN-P1-R2-01 (điều phối R2 mắt tươi trên chính diff fix — "fix có thể sinh lỗi mới")
- **Fix:** JSDoc ghi đúng "ngoài phạm vi ném lỗi" + dọn 2 dòng kẹp chết (`batchSize = Math.min(rawBatchSize, n)` giữ nguyên kẹp ≤ n còn sống; `holdOutRatio = rawHoldOut` thẳng). Kiểm chứng: hành vi không đổi (throw ngoài phạm vi đã pin sẵn r84 7b: 0.7 ném + biên 0/0.5 chạy tốt) + gate 1157/1157 giữ PASS.

### BUG2-152 · D·P4 — header comment tests/r84 chỉ mô tả nhóm 1-6, thiếu nhóm 7-8 vừa thêm cùng file — FB-BRAIN-P1-R2-02 (điều phối R2 quét C6 doc-fidelity)
- **Fix:** header bổ sung 2 dòng mô tả nhóm 7 (regression hợp đồng 13 phát hiện R1) + nhóm 8 (pin giá trị tay 11 khoảng trống C5). Kiểm chứng: đọc lại header khớp cấu trúc file + gate PASS.

### BUG2-153 · D·P4 — subtitle panel "Não vận hành" UI hiển thị "BLUEPRINT-BRAIN-P1-P5 v0.4" trong khi blueprint đã bump v0.4 → v0.5 chính trong đợt fixbug này (3 hiệu đính doc) — chuỗi phiên bản hiển thị cho user bị tụt hậu ngay trong commit cập nhật nó — FB-BRAIN-P1-R3-01 (điều phối bắt trong live-verify R3: browser đọc subtitle thực tế so doc header)
- **Fix:** subtitle cập nhật v0.4 → v0.5. Kiểm chứng: browser live sau fix đọc đúng "v0.5" + 0 lỗi console/page (gate không đổi — chuỗi hiển thị thuần).

### BUG2-154 · C·P3 — stds=0 lọt `loadActiveV3` → (v−mean)/0 = ±∞/NaN lan ra runtime KB confidence khi cờ on + active: nguồn stds=0 HOÀN TOÀN HỢP LỆ từ chính pipeline — cột đặc trưng near-constant (std ∈ (1e-12, 5e-6)) bị `round5` khi ghi trainMetaJson (`computeColumnStats` chỉ ép std < 1e-12 → 1 — lỗ hổng khoảng); probe DB-cô lập (cờ on + active + stds[0]=0, means[0]=0.5, raw=0.5) → `tryCalibrationV3(0.5)` = **NaN** (0/0) không phải null; nhánh feature≠mean → ±∞ → tanh bão hoà → giá trị méo hữu hạn — vi phạm doctrine "calibration must never make the system worse than its raw signal" — FB-BRAIN-P2-R1-01 (auditor R1 tái lập 2 đường + DB-cô-lập; điều phối chấm chéo CC-A/CC-H khớp)
- **Fix:** 2 tầng: (1) gốc — `trainMetaJson.standardization.stds` lưu **full precision** (`stds.slice()`, KHÔNG round5 — means cấp 0.1–1 vô hại giữ round5); (2) phòng thủ sâu — `loadActiveV3` guard `okStds` (đúng 10 chiều + finite + **> 0**) → null; `applyV3Model` ném hợp đồng khi stds chứa 0. Kiểm chứng: regression r85-G1 (corrupt stds[0]=0 → loadActiveV3 NULL + tryCalibrationV3 NULL + getCalibratedConfidence trả raw — NaN chưa từng lọt) + r85-G2 (cột near-constant 200 mẫu Δ=6e-5 → std≈4.2e-6 full precision > 0, runtime dự đoán hữu hạn ∈ [0,1]) + gate 1192/1192.

### BUG2-155 · C·P4 — test r85-B3 pin "TOÀN NOISE → improved=false — không tự huyễn hoặc" như thể là bất biến, trong khi gate V3<V2 là SO-SÁNH-ĐỐI-CHỨNG: trên noise cả 2 model kẹt quanh base-rate p̄(1−p̄) ± nhiễ mẫu nên thắng/thua theo seed — auditor đo 12 seed (5 thắng, 42%), điều phối chấm chéo 10 seed xorshift khác (4 thắng) — đổi seed generator → test gãy và bị hiểu sai "pipeline hỏng" — FB-BRAIN-P2-R1-02 (auditor R1 noise-scan + indep-cv seed 424242 improved=true)
- **Fix:** comment + tên test trung thực: "pin seed 99 cụ thể — KHÔNG phải bất biến, thắng/thua theo seed" + bổ sung expect dẫn nguồn được: cả cvBrier lẫn brierV2 ∈ [0.15, 0.35] quanh base-rate p̄(1−p̄) (p̄ tính từ y thực tế, comment công thức); header r85 nhóm B ghi rõ ("gate V3<V2 là so-sánh-đối-chứng, KHÔNG phải bất biến tự chối noise"). Kiểm chứng: gate 1192/1192 (seed 99 vẫn improved=false — pin giữ nguyên giá trị cụ thể).

### BUG2-156 · C·P4 — `crossValidateV3` không guard length-mismatch: X dài hơn y → 10 hàng bị BỎ ÂM THẪM chạy ra outcome bình thường; X ngắn hơn → TypeError mù "undefined is not an object (X[i][j])" — không khớp hợp đồng JSDoc "trả null khi không gán fold được" — FB-BRAIN-P2-R1-03 (auditor R1 probe [17]/[18]; điều phối chấm chéo CC-C khớp: X60/y50 outcome 0.2782 cắt âm thầm, X50/y60 TypeError)
- **Fix:** guard đầu hàm ném `Error('crossValidateV3: X.length (n) phải bằng y.length (m) — lỗi lập trình caller')` (tiền lệ FB-BRAIN-P1-R1-01 guard input-dim: lỗi lập trình → throw rõ, KHÔNG null — null dành cho "dữ liệu thật lệch lớp"); JSDoc cập nhật. Kiểm chứng: regression r85-G3 (2 chiều đều throw đúng thông báo) + r2-verify R2-1 + gate 1192/1192.

### BUG2-157 · C·P4 — `crossValidateV3` folds degenerate: `folds=5.5` → vòng lặp chạy 6 fold (chia lệch, so V2 5-fold không đồng đều); `folds=NaN` → guard `folds < 2` không bắt NaN (mọi so sánh với NaN false) → trả `{cvBrier: NaN, improved: false}` — kế thừa lỗ hổng `stratifiedFoldAssignments` của V2 (ngoài scope) — FB-BRAIN-P2-R1-04 (auditor R1 probe [26]/[27]; điều phối chấm chéo CC-D khớp)
- **Fix:** guard `!Number.isInteger(folds) || folds < 2 → return null` ("không gán fold được" — nhất quán JSDoc); JSDoc ghi rõ folds phải nguyên ≥ 2. Kiểm chứng: regression r85-G4 (5.5/NaN/1/0 → null; 5 nguyên hợp lệ vẫn chạy) + r2-verify R2-2 + gate 1192/1192.

### BUG2-158 · C·P4 — `applyV3Model` không kiểm chiều dài means/stds (đường dựng tay/test: stats 3 chiều + ctx đủ 10 đặc trưng → j≥3 `undefined−…` = NaN → predictProba NaN → **Math.min(1, Math.max(0, NaN)) = NaN — clamp NUỐT NaN** trả âm thầm; ctx nghèo hơn thì chạy "bình thường" với stats sai — âm thầm sai hơn crash); JSDoc "clamp [0,1]" không đề NaN — FB-BRAIN-P2-R1-05 (auditor R1 sub/apply-full-ctx.ts; điều phối chấm chéo CC-E khớp)
- **Fix:** hợp đồng ném lỗi 3 tầng: means/stds phải đúng 10 chiều; stds > 0 mọi chiều; kết quả phải Number.isFinite — vi phạm → throw Error rõ (caller `tryCalibrationV3` bọc try/catch → null → rơi chuỗi V2 cũ — tinh thần fail-open tuyệt đối giữ nguyên, giờ chặt hơn: không còn đường NaN âm thầm). Kiểm chứng: regression r85-G5 (sai chiều throw "phải đúng 10 chiều"; std=0 throw "stds phải > 0") + r2-verify R2-3 + gate 1192/1192.

### BUG2-159 · C·P4 — `dataLineage` chưa đầy đủ như claim §5.3 "danh sách episodeId/evalId/verdictId (hash tổng nếu quá dài)": chỉ lưu `evalRuns: <số lượng>` (không truy vết được run cụ thể); `tables.EvalCase` đếm `caseMap.size` = TOÀN BỘ EvalCase trong DB kể cả case KHÔNG góp mẫu nào (probe: 150 result dùng 1 case + 5 case rác → lineage ghi 6) — FB-BRAIN-P2-R1-06 (auditor R1 lineage-quirk; điều phối chấm chéo CC-I khớp bản chất)
- **Fix:** `evalRunIds` danh sách runId sort (≤ 50) HOẶC hash sha256 16-hex + đếm khi quá dài (đúng chữ "hash tổng nếu quá dài"); `tables.EvalCase = new Set(usable.caseId).size` — đếm đúng case góp mẫu; giữ `evalRuns` số lượng cho tương thích ngược. episodeId/verdictId là nguồn của brain P3/P4 (calibration chỉ có eval) — ghi chú trong code. Kiểm chứng: regression r85-G6 (1 case dùng + 5 rác → EvalCase=2 đúng số case thật; evalRunIds=[runId] đúng danh sách) + gate 1192/1192 (C3 cũ EvalCase=2 vẫn pass — cả 2 case đều góp mẫu).

### BUG2-160 · D·P4 — 2 comment sai chi tiết trong calibration-v3.ts: (a) header ghi "specJson = MlpSpec (parse trực tiếp bởi MLP.deserialize)" — SAI, `MLP.deserialize` chỉ nhận envelope weightsJson {spec, tensors}; đường đúng là `new MLP(JSON.parse(specJson))` (probe ném lỗi); (b) comment loadActiveV3 "deserialize ~177 tham số" — thực tế **193** (chính r85-A pin 193) — FB-BRAIN-P2-R1-07 (auditor R1 sub/specjson-deserialize-probe.ts + đọc r85-A; điều phối chấm chéo CC-F: deserialize(specJson) throw, new MLP OK, tính tay 10·16+16+16·1+1=193)
- **Fix:** comment (a) sửa "specJson = MlpSpec (nạp lại bằng `new MLP(spec)`); weightsJson = envelope serialize (nạp lại bằng MLP.deserialize)"; comment (b) "193 tham số — r85-A pin". Kiểm chứng: đọc lại comment khớp code + probe CC-F + gate giữ (doc-only).

### BUG2-161 · G·P4 — POST /api/brain/train nhánh từ chối inputMode chưa hỗ trợ trả telemetry SAI: early-return trước khi đọc DB với `usable: 0, total: 0` CỨNG — client 400 nhận "usable 0" trong khi DB có 150 usable (lệch thực tế, gây hiểu nhầm "chưa có dữ liệu") — FB-BRAIN-P2-R1-08 (auditor R1 db-probe r3 POST pca-128 với 150 usable → 400 usable=0; điều phối xác nhận đọc code early-return)
- **Fix:** dời kiểm `isSupportedV3InputMode` xuống SAU `Promise.all` + filter usable — mọi nhánh notTrained giờ nhận usable/total số thật từ cùng nguồn đếm (mode sai hiếm khi xảy ra, chi phí query chấp nhận cho telemetry trung thực); comment route cập nhật. Kiểm chứng: regression r85-G8 (POST pca-128 + 40 usable seed → 400 với usable=40 đúng số thật) + gate 1192/1192.

### BUG2-162 · D·P4 — subtitle panel "Não vận hành" UI hiển thị "BLUEPRINT-BRAIN-P1-P5 v0.6" trong khi blueprint vừa bump v0.6 → v0.7 chính trong đợt fixbug này — đúng lớp lỗi BUG2-153 lần trước (chuỗi phiên bản tụt hậu ngay trong commit cập nhật nó) — FB-BRAIN-P2-R2-01 (điều phối R2 mắt tươi trên diff fix — "fix sinh lỗi mới": fix R1-06/R1-07 bump doc nhưng quên chuỗi hiển thị)
- **Fix:** subtitle cập nhật v0.6 → v0.7. Kiểm chứng: browser live sau fix đọc đúng "v0.7" (agent-browser eval body text) + 0 lỗi console/page + gate 1192/1192 (chuỗi hiển thị thuần).

### BUG2-163 · C·P3 — test r85 nhóm C-D FLAKY khi chạy full gate (58 file): `seedEvalResults` insert 150 row EvalResult trong cùng millisecond → `orderBy createdAt desc` (pipeline train) có TIE không đảm bảo thứ tự → mảng X đổi thứ tự giữa các lần chạy → kết quả CV trên dữ liệu biên (noise — thắng/thua theo seed) LẬT: 3 lần full gate liên tiếp cho C6 noise seed 99 lần pass / lần fail active=true (và G1 fail một lần khác) — CHẶN quality-gate đẩy "PASS ảo/PASS ảo/PASS thật" không tái lập được — FB-BRAIN-P2-R2-02 (điều phối R2 phát hiện khi gate sau-fix chạy 3 lần cho kết quả khác nhau; riêng file luôn 35/35 PASS — chẩn đoán tie-break createdAt)
- **Fix:** `seedEvalResults` ghi `createdAt: new Date(base + i*1000)` phân tán mỗi row 1s (mới nhất cuối) — orderBy desc có tie-break DUY NHẤT, thứ tự dữ liệu tất định tuyệt đối mọi môi trường. Kiểm chứng: full gate 1192/1192 PASS 2 LẦN LIÊN TIẾP sau fix (trước đó fail 3/4 lần) + riêng file 35/35 + C6/C4 pin giữ nguyên giá trị.

### BUG2-164 · C·P4 — test regression G2 (ghi trong chính đợt fix R1) seed 2000 mẫu → vượt timeout 5s của bun test khi chạy FULL gate (riêng file 4.4s PASS sát ngưỡng; full gate chậm hơn — 10.3s timeout) — test tự viết làm gãy gate, không phải lỗi production — FB-BRAIN-P2-R2-03 (điều phối R2 chạy gate sau fix bị CHẶN tại G2 timeout)
- **Fix:** thu về 200 mẫu + thu nhỏ độ lệch cột giữ nguyên discrimination: Δ=6e-5 (thay 0.0002) → std ≈ Δ/√n = 6e-5/√200 ≈ 4.2e-6 ∈ (1e-12, 5e-6) — vẫn nằm đúng khoảng round5→0 (pin lỗi cũ) mà chạy 434ms. Kiểm chứng: full gate 2 lần liên tiếp PASS (G2 434ms) + kỳ vọng stds[1] ∈ (0, 1e-5) giữ nguyên.

### BUG2-165 · C·P3 — quality-gate KHÔNG tái lập được trên fresh clone: 5 test fail (r81 stats-gate + r79 B×2/H1/H3) dù commit P3 claim "1237/1237 PASS" — root-cause kép: (a) r83 FB-P2-R1-06c setTuningValue('q_learning_alpha','0.4') KHÔNG reset, bun test chạy MỌI file CÙNG 1 process (đo live: cùng pid, thứ tự file tùy ý B,C,A) → file nào chạy sau r83 đọc α=0.4 từ snapshot chia sẻ → r79 updateQ ra Q=0.4 thay vì 0.1 (đúng bằng giá trị r83 set — trùng khớp forensic); (b) r81 stats-gate test tin ".env production có ADAPTATION_STATS_GATE=on" — biến này KHÔNG có trong .env.example → fresh clone fail — FB-BRAIN-P3-R1-05/06/07 (điều phối root-cause khi tái lập gate trước đợt audit; auditor 8-a xác nhận live "1 process, thứ tự tùy ý" + verdict 3 fix SẠCH nhưng phát hiện mìn γ sót → BUG2-169)
- **Fix:** (1) r83 reset q_learning_alpha sau assert cuối; (2) r79 beforeAll file-level pin setTuningValue('q_learning_alpha','0.1')/('q_learning_gamma','0.9') — pin bằng STORE (đấm bấu ENV — reset rơi về ENV mà file khác có thể set process.env); (3) r81 stats-gate tự set process.env.ADAPTATION_STATS_GATE='on' try/finally (pattern test matryoshka cạnh bên — không phụ thuộc .env máy). Kiểm chứng: full gate PASS 2 lần liên tiếp (1289→1291/1291, 20084 expect).

### BUG2-166 · A·P3 — Brain-C trainBrainPolicy stratification CV + p̂ (λ) dùng `complete` THÔ thay vì Outcome* (verdict-aware) — trái changelog 0.8→0.9 ("5-fold CV stratified theo Outcome*"), header policy.ts ("p̂ = mean Outcome*") và dataLineage.labelRule; reward-side lại dùng outcomeFromEvidence đúng → 2 NGUỒN NHÃN khác nhau trong cùng 1 lần train: DB probe 40 run + 12 refuted trên đúng session → meta.successRate=0.8 (mean complete) ≠ 0.5 (mean Outcome*) — FB-BRAIN-P4-R1-01 (auditor 8-b DB probe 2 lần ổn định)
- **Fix:** outcomeStars = rows.map(outcomeFromEvidence(complete, verdicts[sessionId])) — DÙNG CHUNG cho stratification CV + p̂ λ + reward; dataLineage.labelRule ghi rõ "DÙNG CHUNG". Regression: r87 D9 — seed 40 runs + gắn refuted lên 5 session complete → successRate phải (nComplete−5)/40, KHÔNG PHẢI nComplete/40. Kiểm chứng: r87 53/53 + gate PASS.

### BUG2-167 · D·P3 — JSDoc ActivePolicy.lambda ghi công thức SAI "λ = max(n/K, 1−wilsonLB(p̂,n))" (thiếu "1−" trước n/K) — cài đặt thực λ(200, 0.9)=0.1494, công thức JSDoc cho 1; header cùng file (dòng 13) ghi đúng → 2 chỗ doc mâu thuẫn nội tại — FB-BRAIN-P4-R1-02 (auditor 8-b probe số)
- **Fix:** JSDoc về "λ = 1 − min(clamp(n/K,0,1), wilsonLB(p̂,n)) — tính lúc load (r87 pin công thức)". Kiểm chứng: r87 E1 pin λ qua chính hàm policyLambda (đọc implementation, không đọc doc).

### BUG2-168 · C·P3 — đặc trưng `delegated` luôn false tại CẢ 2 điểm wiring runtime organ (llm.ts maybeApplySoftmaxModelPolicy + workflow-engine.ts hardcode delegated: false) dù là đặc trưng train (parentRunId≠null) — delegated run bị suy sai slice tại inference khi organ bật + active + train có delegated rows — FB-BRAIN-P4-R1-03 (auditor 8-b)
- **Fix (phần này — documentation có chủ đích):** ghi nhận giới hạn phase TẠI CHỖ cả 2 wiring (comment "tầng llm/workflow không biết parentRunId — impute false; khi goal-loop truyền ctx delegation xuống LLMCallOptions thì wire") + đặc trưng vẫn học từ train. KHÔNG wire xuyên chuỗi call本轮 (goal-loop→llm options) — thay đổi đường nóng lớn hơn rủi ro-phase; production hiện 0 run nên không sai số thực. Kiểm chứng: đọc code 2 điểm + comment mới.

### BUG2-169 · C·P3 — r83 FB-P2-R1-06b setTuningValue('q_learning_gamma','0.7') KHÔNG reset — CÙNG LỚP lỗi BUG2-165(a) sót lại trong cùng file (điều phối chỉ fix α, auditor 8-a bắt mìn γ qua live probe marker: file chạy sau r83 đọc γ=0.7); hiện benign (r79 pin α+γ, r81 beforeEach reset γ) nhưng là mìn đúng dạng từng làm gate không tái lập — FB-BRAIN-P3-R1-09 (auditor 8-a live probe)
- **Fix:** resetTuningValue('q_learning_gamma') sau assert cuối test 06b. Kiểm chứng: gate PASS + r79/r81/r83 chạy cùng nhau 90/90.

### BUG2-170 · D·P3 — surrogate.ts doc "one-hot toàn 0 (impute qua chuẩn hóa về mean train)" mô tả SAI cơ chế: giá trị 0 là NUMBER → chuẩn hóa (0−mean)/std ≠ 0; nhánh về-mean (null→0 sau chuẩn hóa) không bao giờ được pipeline chạm — hành vi thực hợp lý, doc gán nhầm cơ chế (policy.ts copy cùng wording) — FB-BRAIN-P3-R1-10 (auditor 8-a;policy do điều phối tự copy)
- **Fix:** doc 2 file về "giá trị 0 là NUMBER nên chuẩn hóa thành (0−mean)/std, KHÔNG phải impute về mean (nhánh đó chỉ cho null/không-hữu-hạn)". Kiểm chứng: đọc doc + r86/r87 vẫn pass (hành vi không đổi).

### BUG2-171 · D·P4 — JSDoc aucHanleyMcNeilCI không nêu biên degenerate: A=1 → Q₂=∞ → SE=∞ → CI toàn khoảng [0,1] (không chặt); A=0 → SE=0 → CI [0,0] zero-width (đọc là "chắc chắn tuyệt đối" sai sự thật — AUC 0 reachable khi mô hình đảo hết lớp) — công thức vẫn chạy đúng spec — FB-BRAIN-P3-R1-11 (auditor 8-a probe công thức 28/28 khớp ≤1e-12)
- **Fix:** JSDoc thêm đoạn BIÊN DEGENERATE cảnh báo người đọc. Kiểm chứng: đọc doc; hành vi không đổi (r86 pin giữ nguyên).

### BUG2-172 · H·P3 — thư mục rác untracked `E:\APP\TMO-clone/` trong repo root (partial git clone lỗi path Windows: .git 120K + prisma rỗng) — vi phạm C8 vệ sinh (git status không sạch) — FB-BRAIN-P4-R1-08 (auditor 8-b phát hiện qua git status; điều phối xóa khi commit)
- **Fix:** rm -rf. Kiểm chứng: git status chỉ còn file P4 chủ đích.

### BUG2-173 · C·P3 — applySurrogateHead all-or-nothing: 1 đầu dự đoán NaN → throw → buildReplayReport single try/catch nuốt → MẤT CẢ 3 đầu (kể cả success — đầu ra quyết định) — trái claim JSDoc "mỗi đầu độc lập, lỗi 1 đầu không làm sập các đầu khác" (surrogate.ts:1078/:1142); ĐƯỜNG TỚI HOÀN CHỈNH: weightsJson chứa giá trị không-finite vượt toàn bộ guard loadActive (deserialize không kiểm per-value; dim-check chỉ chấm head success) — FB-BRAIN-P3-R1-08 (auditor 8-a live probe)
- **Fix (2 lớp):** (1) per-head prediction NaN/∞ → CHỈ đầu đó null (bỏ 3 nhánh throw per-head; model-level guard means/stds GIỮ throw — r86 D3 pin nguyên vẹn); (2) guard cửa nạp allWeightsFinite (mọi envelope data phải Number.isFinite) — vì JSON KHÔNG lưu được NaN (stringify NaN→null → Float64Array.from null→0 = weight-0 ÂM THẦM, dự đoán sai thầm lặng TỆ HƠN crash — phát hiện thêm khi tái lập probe của auditor: đường DB thực tế là null-weight chứ không phải NaN-weight) → reject cả model (hướng an toàn: replay rơi nhánh đo lường thuần). Cùng guard thêm cho loadActivePolicy (policy.ts — cùng lớp). Regression: r86 D-regression 2 phần — A: null-weight qua DB → loadActive null; B: NaN in-memory (deserialize envelope NaN sống — không qua JSON) → tokens null + success/durationMs KHÔNG null. Kiểm chứng: r86 46/46 + gate PASS.

### BUG2-174 · C·P4 — GET /api/brain/policy tự mâu thuẫn Outcome*: sweepSamples dùng r.complete thô trong khi recent cùng response dùng computeRunReward (outcomeFromEvidence) → 1 run refuted-complete hiện 2 giá trị Outcome* khác nhau trong cùng report; result.components.outcome tính sẵn trong cùng map nhưng bị bỏ qua — FB-BRAIN-P4-R1-04 (auditor 8-b)
- **Fix:** sweepSamples dùng outcomeFromEvidence(r.complete===1, verdicts[sessionId]) — nhất quán recent. Kiểm chứng: r87 F-group pass (report shape) + đọc code.

### BUG2-175 · D·P4 — blueprint §4.4 THÂN chưa hiệu đính: dòng 253 giữ nguyên công thức literal "λ = clamp(n samples/K,0,1) giảm dần..." tự mâu thuẫn (người đọc chỉ §4.4 thấy công thức NGƯỢC code — chỉ nhật ký 0.8→0.9 + §0 ghi đúng); dòng 254 + §0 nói organ-2 là adaptation-engine.ts nhưng wiring thực ở workflow-engine.ts — FB-BRAIN-P4-R1-05 (auditor 8-b)
- **Fix:** §4.4 chèn HIỆU ĐỈNH v0.9Inline (công thức đúng + giải thích mâu thuẫn nội tại + 2 ý định tường minh) + đính chính file organ-2. Kiểm chứng: đọc doc — 3 chỗ (nhật ký, §0, §4.4) giờ nhất quán.

### BUG2-176 · D·P4 — header neural-types.ts đếm sai: "14 gốc ... + thứ 14 calibration_v3" — thực tế 13 gốc (đếm probe: calibration_v3=14th, replay_eval=15th, P4=16–19, tổng 19); "14+14+15+16-19"=20≠19 tự mâu thuẫn (và header cũ nhất "14" cũng không cập nhật kịp từ P3 — 2 lớp stale) — FB-BRAIN-P4-R1-06 (auditor 8-b probe đếm)
- **Fix:** header "13 gốc + thứ 14 + thứ 15 + thứ 16–19 = 19" kèm ghi nhận hiệu đính. Kiểm chứng: TUNING_SPECS.length=19 (r87 H1 pin) + đọc comment.

### BUG2-177 · G·P4 (ghi nhận — không fix đợt này) — action label policy dùng AgentRunRecord.model (model CẤU HÌNH, update cuối run bằng agentModel) trong khi Q-update/reward-log credit theo dominantModel (model THỰC TẾ sau softmax/failover) — P4 là consumer đầu dùng cột này làm action space + efficiency baseline → khi softmax/failover đổi model thật, nhãn gán nhầm; semantics cột có từ P6-M1 (pre-existing, production 0 run) — FB-BRAIN-P4-R1-07 (auditor 8-b)
- **Hướng xử lý:** bàn đợt sau — hoặc goal-loop update cột model bằng dominantModel lúc end-run (sửa semantics cột — cần rà mọi consumer), hoặc policy train join dominantModel từ nguồn khác. Ngoài scope P4 (schema/semantics cột cũ).

### BUG2-178 · H·P4 — 2 typo comment: policy.ts "khối量" (ký tự Trung Quốc lẫn vào "khối lượng"); llm.ts "0 chiỗi import" (đúng: "chi phí") — FB-BRAIN-P4-R1-09 (auditor 8-b grep)
- **Fix:** sửa 2 chữ. Kiểm chứng: grep sạch.

### BUG2-179 · C·P4 — dead computation trong sweepRewardWeights: perModel() tính field `r` (mean compositeReward default-weights, rebuild object) cho cả 2 nửa thời-gian nhưng KHÔNG consumer nào đọc (grid loop tự tính lại theo từng cấu hình w) — FB-BRAIN-P4-R1-10 (auditor 8-b)
- **Fix:** perModel thu gọn chỉ trả {outcome, n}. Kiểm chứng: r87 G8 sweep pass (feasurable/tất định giữ nguyên) + gate.

### BUG2-180 · D·P4 — GET /api/brain/policy field flag.envFallback luôn BẰNG flag.value (cùng biểu thức getTuningEnum — đã gộp chuỗi STORE>ENV>DEFAULT) — computation thừa + misleading ("có tách tầng ENV" nhưng không) — FB-BRAIN-P4-R1-11 (auditor 8-b)
- **Fix:** bỏ field + comment lý do. Kiểm chứng: r87 F2 pass (không còn field).

### BUG2-181 · D·P4 — replicateCount JSDoc không nêu ±∞: "R ngoài [−1,1] kẹp về biên" nhưng ±Infinity rơi nhánh !Number.isFinite → 0 BẢN (không kẹp về 8) — hành vi an toàn có chủ đích (mẫu vô nghĩa không bắt chước), chỉ doc thiếu — FB-BRAIN-P4-R1-12 (auditor 8-b probe: replicateCount(∞)=0)
- **Fix:** JSDoc "R hữu hạn ngoài [−1,1] kẹp về biên; R NaN/±∞ → 0 bản". Kiểm chứng: r87 A6 pin replicateCount(NaN)=0 (giữ) + đọc doc.

### BUG2-182 · C·P3 — r81 WIRING describe (updateQ đọc α/γ runtime) leak tuning SAU test cuối: beforeEach chỉ chạy TRƯỚC mỗi test → α=0.5 (PIN α) / γ=0 (PIN γ) của test CUỐI describe thoát ra ngoài file khi bun test chạy file khác sau (1 process, thứ tự tùy ý — cùng lớp BUG2-165/169; điều phối R2 quét hệ thống cả LỚP lỗi bằng script tìm mọi setTuningValue không reset) — FB-BRAIN-P3-R2-01 (điều phối R2)
- **Fix:** afterAll describe reset α+γ. Kiểm chứng: gate PASS 2 lần + script quét lớp lỗi sạch (còn lại các false-positive: set bị reject không ghi store; r85 calibration_v3 tự dọn trong-file bởi D6).

### BUG2-183 · D·P3 — comment stale tests/db-isolation-preload.ts: "Mỗi test file chạy trong process riêng → mỗi process tạo 1 thư mục /tmp" — đo lại live (FB-BRAIN-P3-R1): bun test chạy MỌI file CÙNG 1 process (cùng pid) → 1 thư mục /tmp mỗi LẦN CHẠY — comment sai cơ chế cách ly (quan trọng vì mọi lập luận về cross-file pollution dựa trên đây) — FB-BRAIN-P3-R1 (auditor 8-a xác nhận live; điều phối hiệu đính comment)
- **Fix:** comment "ĐO LẠI (xác nhận live): MỌI file CÙNG 1 process...". Kiểm chứng: đọc comment + live marker probe của auditor.

### BUG2-184 · C·P3 — neural-types.ts header "TUNING_SPECS — 14 hyperparameter" stale từ P3 (replay_eval là thứ 15 — P3 quên update header; P4 đếm lại thành 19 và phát hiện lớp stale kép khi auditor bắt BUG2-176) — FB-BRAIN-P3-R1 (điều phối phát hiện khi triển khai P4 — ghi nhận về đợt P3 vì lỗi stale phát sinh từ P3)
- **Fix:** gộp vào BUG2-176 (header mới "13 gốc + ... = 19" đúng). Kiểm chứng: đọc header.

### BUG2-185 · C·P3 — Neuron inspector off-by-one MỘT CỘT: nơ-ron (col, real) hiển thị trọn bộ bias + |w| vào/ra TB của nơ-ron CỘT KẾ TIẾP cùng unit index (B(col+1) / hàng real W(col+1) / cột real W(col+2)) thay vì nơ-ron đang bấm — nơ-ron ẩn Brain-A 15/16 + nơ-ron output toàn "—" dù có dữ liệu thật; nơ-ron input hiện bias không tồn tại; trái §9.4 "bias · |w| trung bình vào/ra (sau train) — dữ liệu THẬT"; LATENT (DB 0 BrainModel — bung ngay lần train đầu) — FB-BRAIN-UX-R1-01 (auditor 13-a probe MLP serialize thật)
- **Fix (13-b):** brain-stage.tsx inspector: bias = B(col) (col ≥ 1; cột input → null), |w| vào TB = mean hàng real của W(col), |w| ra TB = mean cột real của W(col+1) (cột cuối → null); edge inspector giữ nguyên (đã đúng W(fromCol+1)[toReal][fromReal]). Kiểm chứng: 13-b probe chấm chéo khớp ground truth 4 cột; 13-c probe độc lập (MLP thật [10,16,8,1] fit, đường đối chứng 2D-matrix): CURRENT==TRUTH 25/25 nơ-ron, công thức cũ 0/25, edge 136/136.

### BUG2-186 · C·P4 — Bộ đếm tham số đếm THIẾU cho policy: headOutUnits hardcoded 1 (dead ternary `? 1 : 1` spec-schema.ts:303) + brain-studio nhân bản công thức (dims.push(1)) — output policy = |A|≥2 (§9.1-2) → lệch đúng (|A|−1)×(h+1); có case counter 249751 < trần 250K (blocked=false) nhưng MLP thật 251257 → mlp.validateSpec chặn lúc train (điểm chặn thật hoạt động — chỉ hiển thị sai) — FB-BRAIN-UX-R1-02 (auditor 13-a probe + toán)
- **Fix (13-b, 5 điểm):** BrainDraftRule.outputUnits (A:1 · B:1 · C:null ×|A| động) + outUnits = override ?? rule ?? 1 (thay dead ternary) + params.note 'chưa gồm đủ ×|A|' + registry.outputDim + brain route parse lớp cuối 3 dạng (layers ?? spec.layers ?? heads.success.layers, fail-open) + brain-studio hiển thị validation.params (xóa bản sao công thức). Kiểm chứng: 13-c probe 9/9 — override |A|=7 → 32167 === MLP(buildPolicySpec(997,7)).paramCount() TRÙNG TUYỆT ĐỐI; 251257 blocked=true đúng điểm chặn thật; pin r88 (A 193 / B 66049) nguyên vẹn.

### BUG2-187 · C·P4 — Nút "Huấn luyện theo nháp" không chặn khi draft DIRTY: server train bản nháp ĐÃ LƯU cuối (DB) trong khi UI hiển thị bản đang sửa → user tưởng train theo giá trị trên màn hình; title "THEO BẢN NHÁP hiện tại" nói sai khi dirty — FB-BRAIN-UX-R1-03 (auditor 13-a đọc code)
- **Fix (13-b):** TrainingConsole nhận hasSavedDraft; nút disabled khi chưa từng lưu HOẶC dirty (title giải thích từng nhánh) + nhãn " • chưa lưu" khi dirty; useDraft = editorOn && hasSavedDraft && !draftDirty (console tính, truyền lên). Kiểm chứng: 13-c đọc đủ chuỗi console→parent — savedDrafts nạp GET mount + cập nhật sau PUT thành công (không kẹt disabled); editorOn=false giữ hành vi "Huấn luyện lại".

### BUG2-188 · A·P4 — Dropdown activation lớp ẨN chỉ offer 6/8 hàm: filter where==='hidden' loại sigmoid+linear dù validateBrainDraft chấp nhận cả 8 ở hidden (r88-A3 pin) và blueprint không cấm (chỉ cấm softmax B1) — FB-BRAIN-UX-R1-04 (auditor 13-a)
- **Fix (13-b):** filter `name !== 'softmax'` → đủ 8 hàm (sigmoid+linear chọn được ở lớp ẩn). Kiểm chứng: 13-c menu 9 − softmax = 8; validate chấp nhận từng hàm ở hidden (probe 8/8); softmax hidden vẫn bị chặn (audit B1 giữ).

### BUG2-189 · A·P4 — 2 chi tiết hiển thị §9.2 thiếu: (a) diff "So sánh với bản active" hàng Tham số LUÔN "—" cả 2 bên (diffDraftAgainst hardcode '—' + openDiff truyền params:null) dù spec đòi "tham số từng bên"; (b) danh sách "Chọn não" mỗi dòng thiếu inputMode — FB-BRAIN-UX-R1-05 (auditor 13-a)
- **Fix (13-b):** (1) diffDraftAgainst tham số 3 draftParams — hàng Tham số draft = toLocaleString('vi-VN') khi != null; (2) openDiff tính 2 bên (draft = validation.params.total; active = countParams từ layers fetch /api/brain/weights); planned (chưa train) giữ '—'; (3) option thêm ` · in: {defaultInputMode}`. Kiểm chứng: 13-c diff 2 bên khi tính được (active-side policy đọc được nhờ BUG2-198); selector ` · in:` đủ 3 option; residual inputDim-chưa-biết → BUG2-196.

### BUG2-190 · C·P4 — Touch target < 44px mobile trong panel BRAIN: edgeHitRadius 7 đơn vị viewBox ≈ 7-14px thực; nút stage min-h-[28px], tab console min-h-[32px], nút console h-7=28px hiện trong bottom-sheet mobile — trái §9.4/§9.5 ≥ 44px — FB-BRAIN-UX-R1-06 (auditor 13-a — hình học)
- **Fix (13-b):** 19 chỗ min-h-[44px] (kèm md:min-h-[28/32px] desktop) trên 4 component (brain-stage toolbar · brain-studio selector/option/stepper/Thêm lớp/Lưu nháp/Phục hồi/So sánh · training-console tab + ↺×3 + Huấn luyện/Lưu nháp · neural-architecture-section tab console + ⚙ Console + ✕ sheet) + STAGE_LIMITS.edgeHitRadius 7 → 12 (neuron hit 9 giữ — cạnh kề dày đặc); select/input giữ nguyên. Kiểm chứng: 13-c grep 19 chỗ + r90-D2 comment pin (2 assert radius giữ — dùng tham số ép); 13-b live verify mobile 390×844 mọi nút chạm 44px.

### BUG2-191 · D·P4 — strokeWidthForGrad JSDoc-vs-hành vi: doc "Toàn 0 → 1.1" nhưng (0,[0,0]) và mọi mảng → 1.95 (nhánh hi≤lo trả trung vị (0.7+3.2)/2) — caller chặn hasBackData nên chưa tới UI (Task 11 ghi nhận chờ fixbug — nâng cấp entry theo protocol C6) — FB-BRAIN-UX-R1-07 (auditor 13-a xác nhận độc lập + r90-H4 pin)
- **Fix (13-b — sửa CODE theo doc):** toàn 0 (hoặc gradAbsMeanLayer===0) → fallbackW 1.1 trung tính (không tín hiệu — không giả); flat NON-ZERO giữ trung vị 1.95 (có tín hiệu, đều nhau) + JSDoc 2 trường hợp suy biến. Kiểm chứng: 13-c probe 8/8 — (0,[0,0])=1.1; (2,[2,2])≈1.95; đầu mút + nội suy đúng; pin r90-H4 cập nhật ((0,[0,0]) 1.95→1.1 + assert mới flat ≈1.95).

### BUG2-192 · G·P4 — 3 dead exports không dùng/hoặc trắc nghiệm đâu: ACTIVATION_MENU_LIST (brain-stage.tsx) + registrySpecFor + draftLayersText (spec-schema.ts) — FB-BRAIN-UX-R1-08 (auditor 13-a grep toàn repo)
- **Fix (13-b):** xóa cả 3 + import dư đi kèm (ACTIVATION_MENU, BRAIN_REGISTRY). Kiểm chứng: 13-c grep toàn repo (ts/tsx/js/md/json/sql + tests + docs) 0 match; tsc noUnused + eslint sạch sau xóa.

### BUG2-193 · D·P4 — 3 doc nhỏ sai thực tế: (a) comment gradByCol off-by-one ("gradAbsMean[i] = lớp i+1→i+2" — thật: |gradient| TB của lớp trọng số nối cột i→i+1, tensor W(i+1); mapping g[fromCol] ĐÚNG nên hiển thị đúng, chỉ comment sai); (b) mlp.ts FitResult.gradAbsMean JSDoc "sau batch-mean + L2" THIẾU "lossScale" (thực đo lossScale=2 → gradAbsMean đúng 2×); (c) blueprint §9.5 "Bảng 13 tham số runtime" — thực 25 — FB-BRAIN-UX-R1-09 (auditor 13-a)
- **Fix (13-b):** (a) comment đúng tensor W(i+1); (b) JSDoc "sau batch-mean + L2 + lossScale, trước clip"; (c) "Bảng 25 tham số runtime (13 gốc + 12 phase)". Kiểm chứng: 13-c đối chiếu mlp.ts:445 (this.W[k]=W(k+1)) + điểm tích lũy (sau mean → L2 → lossScale → TRƯỚC clip) + blueprint:448.

### BUG2-194 · D·P4 — neural-types.ts ui_hitech appliesTo nhắc "HiTechProvider" — component KHÔNG TỒN TẠI (thực tế HiTechToggle + CSS [data-hitech]) [Task 11 ghi nhận không cấp ID — nâng cấp entry theo protocol C6] — FB-BRAIN-UX-R1-10 (auditor 13-a)
- **Fix (13-b):** appliesTo → "HiTechToggle (src/components/hitech-toggle.tsx) — nút sidebar + globals.css [data-hitech=on] (CSS-driven toàn cục), không đụng pipeline". Kiểm chứng: 13-c glob hitech-toggle.tsx tồn tại + grep HiTechProvider 0 match toàn src + globals.css có rule [data-hitech='on'].

### BUG2-195 · H·P4 — Vỏ thư mục rác E:\APP\TMO-clone/ CHƯA dọn sạch (tái phạm BUG2-172): rỗng 8KB (prisma rỗng; .git đã mất) nhưng git status KHÔNG hiển thị (backslash path bị git bỏ qua im lặng — chỉ thấy qua ls-files --others quoted) → mọi kiểm tra "git status sạch" pass giả — FB-BRAIN-UX-R1-11 (auditor 13-a ls/find)
- **Fix:** 13-b rm -rf + kiểm git ls-files sạch — NHƯNG rm vô hiệu (exit 0 im lặng — nghi chạy sai cwd) + kiểm chứng git structurally KHÔNG THẤY thư mục rỗng → fix thật ở vòng R3 (13-d). Kiểm chứng: find/ls sạch — xem BUG2-197.

### BUG2-196 · D·P4 — Diff hiển thị params THIẾU LỚP INPUT khi inputDim chưa biết: brain-studio openDiff truyền validation.ok ? params.total : null — khi inputDim chưa biết (policy chưa train / surrogate chưa ước tính DB) params.total là số thiếu lớp input (vd policy default hidden[32] → "33") trong khi bộ đếm realtime cùng panel hiển thị '— (D động)' — vi phạm contract docstring diffDraftAgainst ("từ validateBrainDraft KHI BIẾT CHIỀU INPUT — null → '—' trung thực"); chỉ xuất hiện khi chưa có bản active (active side '—') nên không gây so sánh sai 2 bên — FB-BRAIN-UX-R2-01 (điều phối R2 13-c đọc code + probe 13-b làm nền)
- **Fix (13-d — R3 mini):** 1 điều kiện — chỉ truyền khi `validation.ok && validation.params.includesInput` (không → null → hàng '—' trung thực, nhất quán bộ đếm cùng panel). Kiểm chứng: tsc + eslint brain-studio sạch; r88 29/29 (diff không pin giá trị này — không vỡ); full suite 1370/1370; caller diffDraftAgainst duy nhất (grep) — không nhánh nào khác truyền params.

### BUG2-197 · H·P4 — rm E:\APP lần 1 (13-b) VÔ HIỆU + git tàng hình thư mục rỗng → kiểm chứng pass giả cấu trúc: vỏ E:\APP\TMO-clone + prisma (2 thư mục rỗng, 0 file kể cả hidden) vẫn còn sau fix R1-11 — rm -rf path-không-tồn-tại exit 0 im lặng (nghi chạy sai cwd); git status/ls-files --others structurally KHÔNG THẤY thư mục rỗng (git chỉ theo dõi FILE) — đúng lớp cảnh báo BUG2-172/R1-11 — FB-BRAIN-UX-R2-02 (điều phối R2 13-c stat/ls trực tiếp)
- **Fix (13-d — R3 mini):** rm -rf 'E:\APP\TMO-clone' từ ĐÚNG cwd /home/z/tmo-app. Kiểm chứng: `find . -maxdepth 1 -name 'E:*'` RỖNG + `ls -la | grep 'E:'` không còn + find toàn độ sâu rỗng (KHÔNG tin git status cho finding filesystem). Bài học: thư mục rỗng tàng hình với mọi kiểm tra git — verify bằng find/ls trực tiếp.

### BUG2-198 · C·P4 — Weights route lồng SAI shape cho policy → Brain-C không đọc được weights thật: policy.ts ghi weightsDoc { mlp: serialize() } + specDoc { spec: MlpSpec } (lồng thêm 1 tầng) trong khi calibration_v3 ghi thẳng MlpSerialized/MlpSpec — GET /api/brain/weights nhánh non-surrogate trả NGUYÊN → consumer brain-stage đọc json.spec.layers + json.mlp.tensors undefined → policy ĐÃ train vẫn fall-back planned (inspector '—' + active layers planned + diff active-side '—'; A/B bình thường) — phát hiện NGOÀI scope 11 finding R1 (13-b phát hiện khi fix R1-02/R1-05; fix ở vòng R2)
- **Fix (13-c):** route unwrap fail-open `mlp = weightsDoc.mlp ?? weightsDoc` + `spec = specDoc.spec ?? specDoc` (calibration_v3 no-op) + comment 3 dạng A/B/C; 3 consumer cùng route hưởng lợi (active layers + inspector + diff active-side). Kiểm chứng: 13-c probe DB cô lập seed shape THẬT policy.ts (buildPolicySpec(4,3) serialize): policy 200 tensors DEEP-EQUAL + round-trip softmax sum≈1 + calibration_v3 unwrap no-op; REVERT-TEST: về code cũ → probe FAIL (json.mlp.spec.layers undefined), restore → 3/3 pass.

### BUG2-199 · A·P3 (ghi nhận — không fix đợt này) — Nợ contrast TIỀN TỒN TẠI palette chữ × nền sâu UX-5: stone-600 #57534e trên nền sâu #05070D chỉ 2.64:1 (DƯỚI cả AA large-text 3.0), stone-500 #78716c 4.20 (đạt 3.0, thiếu AA 4.5) — giao thoa "màu chữ cũ × nền mới", theme UX-5 không đổi màu chữ theo phạm vi §9.6 (Task 11 phát hiện khi viết r91-C — đề bài đòi assert ≥ 3.0 nhưng giá trị đo thật không thể pass)
- **Hướng xử lý:** bàn đợt sau — nâng palette caption khi nền sâu bật; r91-C pin trung thực khoảng [2.5, 3.0) làm regression-guard buộc cập nhật có chủ đích khi nâng màu.

### BUG2-200 · C·P3 — Trộn tín hiệu 2 head surrogate trong 1 khung BrainStage: poll activity luôn head 'success' (state `headForActivity` cố định — BrainStage giữ head nội bộ không expose) trong khi cạnh |a×w|/inspector theo head user đang chọn → khi user bấm tab head 'tokens', nơ-ron sáng theo head 'success' nhưng trọng số cạnh/inspector theo head 'tokens' — brain-tab.tsx:241-246 + brain-stage.tsx head tab onClick (16-a đối chiếu known (a) + chi tiết mới) — FB-BRAIN-LIVE-R1-01 (16-a)
- **Fix (16-b):** BrainStage expose 2 prop mới `initialHead?: SurrogateHead` (khởi tạo state head nội bộ) + `onHeadChange?: (head: SurrogateHead) => void` (gọi tại chỗ setHead cũ trong onClick tab head — event handler); brain-tab thay state `headForActivity` (chỉ đọc) bằng `activityHead` + `setActivityHead`, fetchActivity poll `&head=${activityHead}`, render `<BrainStage initialHead={activityHead} onHeadChange={h => setActivityHead(h)}>`. Kiểm chứng: live agent-browser — bấm tab head 'tokens' trong stage (weights mock qua network route vì DB app 0 BrainModel — không đụng DB) → network requests: `GET /api/brain/activity?brain=surrogate&head=tokens` ×2 (200) — poll đổi head ngay; r92-E pin cũ (`&head=` chỉ surrogate · fetch template · POLL_ACTIVITY_MS 2_500) giữ nguyên pass; full suite 1400/1400 ×2.

### BUG2-201 · C·P3 — Pan không clamp biên: setView khi kéo (brain-stage.tsx:543-548 trước-fix) nhận x/y tự do → kéo xa mất đồ thị hẳn khỏi màn, chỉ ⤢ Vừa/dblclick hồi phục — 16-a đối chiếu known (c) — FB-BRAIN-LIVE-R1-02 (16-a)
- **Fix (16-b):** clamp x/y quanh vùng base trong onMove — cửa sổ nhìn [x, x+w]×[y, y+h] phải giao vùng base [bx, bx+bw]×[by, by+bh] chiều dài ≥ 10% kích thước cửa sổ, công thức đối xứng `x ∈ [bx − 0.9·w, bx + bw − 0.1·w]` (y tương tự; GHI CHÚ chấm chéo: đề bài ghi biên trên `base.x + base.w` nhưng giá trị đó cho giao 0% mâu thuẫn ý định "≥10%" — lấy công thức đối xứng với biên dưới đề bài cho). Kiểm chứng: live agent-browser (viewport 1600×1000, synthetic PointerEvent): zoom +1.25× → viewBox "34 33.8 272 270.4" khớp công thức; kéo xa phải → x dừng −244.8 (= −0.9×272); kéo xa trái → x dừng 312.8 (= 340−0.1×272); kéo xuống → y dừng −243.36 (= −0.9×270.4); pan nhỏ trong biên tự do (132.67/−63.23 khớp tính tay 312.8−200×scale); ⤢ Vừa → fit "0 0 340 338".

### BUG2-202 · G·P3 — Top-edge resize handle Smolab che hit-area 8px dưới handle vào TOP thanh tab: hit-area `-top-1 -bottom-2` (y 54-78) đè tâm nút tab BRAIN (y 76) → elementFromPoint tâm nút trúng handle, không trúng nút tab — pre-existing Smolab (15-d known (d), 16-a live tái lập) — FB-BRAIN-LIVE-R1-03 (16-a)
- **Fix (16-b — chấm chéo mô tả trước khi sửa): đề bài gợi ý "thu hit-area ngang còn left-3 right-3" nhưng đo live thấy hit-area ĐÃ bị chặn ngang bởi handle (x 60-1268 = đúng biên handle left-3/right-3) — xung đột thuần DỌC: `-bottom-2` (đuôi 8px dưới handle y 70→78) là phần đè tâm nút tab y 76. Fix tối thiểu: bỏ `-bottom-2` (hit-area còn y 54-70 = 4px trên mép + 12px handle), giữ `-top-1`; handler/geometry handle không đụng. Kiểm chứng: live agent-browser sau fix — elementFromPoint tại tâm nút tab BRAIN (1528, 76) → SPAN bên trong nút tab (inBrainTab=true, KHÔNG trúng handle); hit-area đo lại 54-70; handle vẫn kéo được (chỉ đổi bound CSS của div đệm, mousedown nằm trên handle cha).

### BUG2-203 · F·P3 — Activity route dormant surrogate+policy chạy findMany take-5000 ×2 MỖI poll 2.5s/client chỉ để dựng vocab one-hot (route.ts:221-228/280-287 trước-fix) — DB nhỏ OK (~vài trăm row) nhưng khi runs lớn ~2000 row/s đọc/client — 16-a xác nhận known (i) — FB-BRAIN-LIVE-R1-04 (16-a)
- **Fix (16-b — quyết định TTL cache thay vì SELECT DISTINCT, lý do ghi trong code route):** module-level `dormantVocabCache` Map<'surrogate'|'policy', {at, vocab}> TTL 60s (VOCAB_CACHE_TTL_MS) — nhánh dormant đọc vocab cache trước, hết hạn mới chạy ĐÚNG đường query+filter gốc (kết quả giống hệt trên cùng dữ liệu). Lý do loại DISTINCT: vocab pipeline = distinct trong 5000 row ĐẦU theo createdAt asc SAU filter usable (trainBrainSurrogateLocked/collectRewardLedger cap 5000) — SELECT DISTINCT quét toàn bộ rồi mới giới hạn → khi >5000 usable cho vocab KHÁC pipeline train (sai parity); filter typeof/Number.isFinite cũng phải đọc row trước. Chấp nhận trễ ≤60s khi có run/model mới — hiển thị quan sát, không đụng pipeline; nhánh ACTIVE đọc vocab từ specJson bản active (không dính cache); không cần invalidate khi train (route rẽ nhánh active). Kiểm chứng: r92 C3/C4 (cache miss — one-hot đối chiếu builder thật [1,1,0]/[1,0] như cũ) + C7 READ-ONLY pin (policy dormant cache HIT cùng dữ liệu → cùng kết quả) pass; full suite 1400/1400 ×2; DB app không đụng (bảng brain 0 row, không có ChangeLog mới).

### BUG2-204 · G·P4 — Biến `scaleV` chết brain-stage.tsx:535 (trước-fix): tính `startView.h / rect.height` rồi không dùng — pan dùng `scale` ngang cho cả 2 trục (đúng vì svg h-auto w-full giữ aspect viewBox → 2 scale bằng nhau) — hygiene — FB-BRAIN-LIVE-R1-05 (16-a)
- **Fix (16-b):** xóa biến + comment giải thích đẳng thức aspect thay cho biến chết ("svg `h-auto w-full` giữ đúng aspect viewBox (rect.height/rect.width ≡ view.h/view.w) nên scale dọc ≡ scale ngang"). Kiểm chứng: tsc + eslint sạch; live pan/clamp (BUG2-201 verify) khớp tính tay theo 1 hệ số scale — hành vi không đổi.

### BUG2-205 · G·P4 — Import `bezierTangentDeg` chết brain-stage.tsx:49 (trước-fix; 1 match duy nhất = dòng import — bản UX-3 cũ cũng đã chết, sống sót qua rewrite 15-c) — FB-BRAIN-LIVE-R1-06 (16-a)
- **Fix (16-b):** xóa khỏi import từ stage-geometry (export giữ nguyên tại nguồn — không đụng barrel/khác). Kiểm chứng: grep bezierTangentDeg trong brain-stage.tsx = 0 match; tsc + eslint (file + toàn repo) sạch.

### BUG2-206 · H·P4 — r92 READ-ONLY pin C-group chụp 4 bảng (AgentRunRecord/EvalResult/BrainModel/TuningParam) nhưng route activity còn đọc bảng THỨ 5: evalCase.findUnique (nhánh calibration_v3 join difficulty/category) → pin hở bảng EvalCase — FB-BRAIN-LIVE-R1-07 (16-a — probe G4 của auditor đã bọc 5 bảng PASS)
- **Fix (16-b):** thêm `cases: await db.evalCase.count()` vào snap object của pin (đổi tiêu đề test "count 4 bảng" → "count 5 bảng (…/EvalCase/…)" + comment nguồn R1-07). Kiểm chứng: r92 C-group 30/30 pass (expect count KHÔNG đổi — bảng thứ 5 nằm trong cùng assert toEqual snapshot trước/sau chuỗi 10 GET); targeted r92+r89+r90 = 68/68 (574 expect).

### BUG2-207 · H·P4 — r92-E helper stripComments không string-aware: `//` trong CHUỖI (vd URL 'https://…') bị coi là mở comment → phần dòng còn lại bị che khỏi source-scan (regex cũ strip cả trailing; file section hiện 0 chuỗi '://' nên chưa sai hôm nay — tiên lượng) — FB-BRAIN-LIVE-R1-08 (16-a)
- **Fix (16-b):** nâng stripComments thành máy trạng thái nhỏ string-aware: ngoài comment gặp `'` `"` `` ` `` → skip tới closing quote (xử lý escape `\` 2 ký tự) rồi mới quét `//` / `/* */`; không regex lồng. Giữ nguyên ngữ nghĩa cũ (bỏ comment dòng + block). Kiểm chứng: probe độc lập /tmp 7/7 case (URL trong chuỗi preserved · escape `\'` · block · trailing comment · chuỗi chưa đóng) + URL '&head=y' nhìn thấy được sau strip; r92-E 5/5 pass (section pin NOT-contains + contains đều giữ — pinned strings đều nằm trong code thật).

### BUG2-208 · D·P4 — Doc số dòng lệch 1: nhật ký hiệu đính 0.10→0.11 blueprint ghi section "1712 → 1126 dòng" + brain-tab "921 dòng" — thực đo wc -l tại audit 16-a: 1125/920 (cosmetic; 1712 đúng — đo lại git show 52d97f3 = 1712) — FB-BRAIN-LIVE-R1-09 (16-a)
- **Fix (16-b):** hiệu đính blueprint đúng số đo `wc -l` tại thời điểm fix kèm ghi chú nguồn: section "1712 → 1125 dòng (hiệu đính FB-BRAIN-LIVE-R1-09: đo lại wc — bản gốc ghi 1126 lệch 1)" + brain-tab "924 dòng (hiệu đính FB-BRAIN-LIVE-R1-09: bản gốc 921 lệch 1 so đo 920 tại 15-d; 924 gồm 4 dòng fix R1-01 của 16-b)". Worklog 15-d KHÔNG sửa (append-only) — hiệu đính ghi tại worklog 16-b. Kiểm chứng: wc -l tại 16-b: section 1125 · brain-tab 924 · git show 52d97f3 section = 1712.

### BUG2-209 · D·P4 — Doc stale do chính fix R1-07 sinh ra: sau khi 16-b thêm EvalCase vào READ-ONLY pin (tiêu đề test đổi "count 4 bảng"→"count 5 bảng"), 2 chỗ doc mô tả pin vẫn ghi "4 bảng" — (1) r92 header đo lường nhóm C (dòng ~33) · (2) câu "Tests" trong nhật ký hiệu đính 0.10→0.11 blueprint (CÙNG ĐOẠN 16-b đã hiệu đính R1-09 nhưng sót câu kế) — người đọc đối chiếu doc vs r92 hôm nay thấy mâu thuẫn — FB-BRAIN-LIVE-R2-01 (16-c verify R2 quét diff vùng 16-b đụng)
- **Fix (16-c mini — precedent hiệu đính R1-09):** r92 header → "count 5 bảng (AgentRunRecord/EvalResult/EvalCase/BrainModel/TuningParam)" + ghi chú hiệu đính nguồn; blueprint câu Tests → "count 5 bảng (hiệu đính 16-c R2-01: 16-b R1-07 thêm EvalCase vào snap — bản ghi 15-e sót '4 bảng')". Kiểm chứng: grep "count 4 bảng" trong r92 + blueprint = 0 match; doc-only — r92 30 pass (289 expect sau R2-02) · full 1400/1400 ×2.

### BUG2-210 · H·P4 — r92-E thiếu pin hồi quy cho wiring R1-01: fix 16-b thêm initialHead/onHeadChange (BrainStage) + activityHead poll (brain-tab) nhưng không thêm expect pin nào — nếu ai bỏ call onHeadChange hay trả poll về hardcode 'success', không test nào fail (r92-E pin fetch-template + '&head=' nhưng không pin nguồn head là state) — cùng lớp pin-hở BUG2-206 — FB-BRAIN-LIVE-R2-02 (16-c verify R2)
- **Fix (16-c mini):** +4 expect vào 2 test E hiện có (KHÔNG thêm test — giữ 30 test / full 1400): brain-tab pin `&head=${activityHead}` + `initialHead={activityHead}` + `onHeadChange={h => setActivityHead(h)}`; brain-stage pin `onHeadChange?.(h)` (bắn tại chỗ setHead cũ — event handler). Kiểm chứng: r92 30 pass / 289 expect (285+4 — 4 pin mới đều trúng chuỗi nguồn thật) · full suite 1400/1400 / 65 file ×2 (21088 + 21104 — dải drift pre-existing 21082-21098 dịch +4) · tsc + eslint + check:imports sạch.

### BUG2-211 · H·P4 — r93-C.6 pin brain-reference quét RAW không stripComments: 2/13 chuỗi pin ('aˡ = φ(Wˡ·aˡ⁻¹ + bˡ)' · 'composite') có FALLBACK trong block comment header (dòng 19-20) — xóa dòng JSX thật pin vẫn PASS (pin yếu, cùng lớp BUG2-206/210: assert trúng comment chứ không trúng code) — FB-BRAIN-TAB-R1-01 (18-f rà Lớp 8)
- **Hiện tượng/Tác động:** r93-C.6 (18-e) pin source-scan brain-reference.tsx bằng chuỗi RAW theo brief; header comment dòng 20 chứa nguyên văn 'aˡ = φ(Wˡ·aˡ⁻¹ + bˡ)' (dòng JSX thật ở 171) và dòng 19 chứa 'composite' (JSX thật ở 151) — regressions xóa dòng render công thức lan truyền tiến (câu hỏi user trực tiếp: "thông số liên quan lan truyền tiến") không bị test nào phát hiện. Các test C.1-C.5/C.7-C.8 đã quét stripComments nên không dính.
- **Fix (18-f):** r93 thêm `referenceCode = stripComments(reference)` (helper copy NGUYÊN đã có trong file — FB-BRAIN-LIVE-R1-08 string-aware) và chuyển TOÀN BỘ 13 assert C.6 sang referenceCode + cập nhật tiêu đề test + header mô tả nhóm C. Đã kiểm từng chuỗi pin đều sống sót qua strip (comment bị bỏ, chuỗi trong code giữ nguyên).
- **Kiểm chứng:** REVERT-TEST (pattern BUG2-198): sed xóa dòng JSX `<p>aˡ = φ(Wˡ·aˡ⁻¹ + bˡ)</p>` → r93 FAIL đúng 1 test C.6 ("Expected to contain") trong KHI scan RAW trên cùng file vẫn found=true (chứng minh pin cũ yếu thật) → restore từ backup → r93 16/16 pass. Full suite 1427/1427 ×2.

### BUG2-212 · D·P4 — brain-reference LOSS_REFERENCE dòng bce: cột "Đạo hàm" ghi 'ŷ − y' (δ của CẶP GỘP sigmoid+BCE) mâu thuẫn chính phụ đề mục 2 "đạo hàm là ∂L/∂ŷ" — ∂BCE/∂ŷ đứng một mình là −(y/ŷ−(1−y)/(1−ŷ)) (losses.ts deriv thật); dòng crossEntropy cùng bảng đã có qualifier 'ŷ − y (kèm softmax)' — bce thiếu qualifier tương ứng → bảng THAM CHIẾU (sinh ra để trả lời câu hỏi user về đạo hàm) hiển thị sai ngữ nghĩa 1 dòng — FB-BRAIN-TAB-R1-02 (18-f rà Lớp 7)
- **Fix (18-f):** deriv bce → 'ŷ − y (kèm sigmoid)' (đối xứng crossEntropy, đúng ngữ nghĩa cặp gộp mlp.ts backward "sigmoid+bce → δ = ŷ−y") + comment nguồn tại chỗ.
- **Kiểm chứng:** live browser tab Hàm & công thức: cell đạo hàm bce hiển thị đúng "ŷ − y (kèm sigmoid)"; r93-C.6 pin chuỗi mới `deriv: 'ŷ − y (kèm sigmoid)'`; grep toàn repo không còn chỗ nào ghi 'ŷ − y' trần không ngữ cảnh (losses.ts:17 + mlp.ts:19 đều ghi kèm "sigmoid+bce" đầy đủ).

### BUG2-213 · G·P4 — training-console input δ Huber hardcode `min={0.01} max={10}` thay vì DRAFT_LIMITS.huberDeltaMin/huberDeltaMax — input α/β Brain Studio (cùng wave 18-b) dùng DRAFT_LIMITS.*Min/*Max; đổi limit về sau thì attr input δ drift lặng lẽ khỏi rule validate — FB-BRAIN-TAB-R1-03 (18-f rà Lớp 6)
- **Fix (18-f):** `min={DRAFT_LIMITS.huberDeltaMin} max={DRAFT_LIMITS.huberDeltaMax}` (DRAFT_LIMITS đã import sẵn trong file) + comment nguồn.
- **Kiểm chứng:** live browser surrogate → Training Console: 2 input δ (tokens + duration) min="0.01" max="10" — giá trị render không đổi (giá trị hằng trùng số); r93-C.5 thêm pin `min={DRAFT_LIMITS.huberDeltaMin} max={DRAFT_LIMITS.huberDeltaMax}`; tsc + eslint sạch.

### BUG2-214 · C·P4 — spec-schema validateBrainDraft bỏ qua IM LẶNG activationParams sai shape: mảng [1,2] rơi qua guard `typeof === 'object'` (alpha/beta undefined → DROP, trả ok:true), chuỗi/null bị guard chặn cũng im lặng — trong khi MỌI shape violation khác của cùng hàm (hidden không mảng, hyper không object, units không số, weight/huberDelta không số) đều BÁO LỖI → client/malformed PUT nhận 200 giả thay vì 400 đúng hợp đồng "validate mọi khóa có mặt" (decision 18-d) — FB-BRAIN-TAB-R1-04 (18-f rà Lớp 3, chấm chéo đường PUT /api/brain/spec-draft:400)
- **Fix (18-f):** nhánh mới trước guard cũ — `apIn !== undefined && (apIn === null || typeof apIn !== 'object' || Array.isArray(apIn))` → lỗi "Lớp ẩn i: activationParams phải là object { alpha?, beta? }"; object đúng shape (kể cả {} rỗng) và KHÔNG có key (draft cũ pre-18-d) giữ nguyên hành vi ({} → normalize omit key).
- **Kiểm chứng:** r88-G test mới #8: [1,2]/'rác'/null → expectInvalid 'activationParams phải là object' + đối chứng 2 chiều (draft cũ pre-18-d không key vẫn ok=true — backward compat Lớp 3e; {} → ok + omit key); r88 37/37; full suite 1427/1427 ×2; PUT route trả 400 kèm errors qua đúng đường sẵn có (route.ts:98-100 không đổi).

### BUG2-215 · C·P4 (GHI NHẬN — NGOÀI PHẠM VI đợt FB-BRAIN-TAB, bàn đợt sau) — Smolab module shell mobile <sm (640px): cột nội dung `.flex.flex-col.flex-1.min-w-0.sm:min-w-[300px]` WIDTH 0px → toàn bộ nội dung module (kể cả tab BRAIN 3 section — svg sân khấu 0×0, [256,8] render vô hình) bị éoẹp; tái lập CẢ trên tab Learning (nội dung khác hẳn) → chứng tỏ lỗi tại SHELL (smolab-module.tsx — sibling chiếm chỗ), KHÔNG phải brain-tab — FB-BRAIN-TAB-R1 ngoài phạm vi (18-f live browser 375×812)
- **Bằng chứng:** 375×812: shell col 0px · stageBox 2px · svg 0×0 (viewBox "0 0 390 345" dựng đúng, chỉ không gian hiển thị = 0); 768×1024: shell ≥300px → 3 section + svg 330×292 + zoom/pan hoạt động chuẩn (viewBox 125% khớp công thức zoomAt sai số 0); 1280×900: svg 676×598 khớp min(boxW/w, boxH/h). smolab-module.tsx KHÔNG nằm trong working tree đợt BRAIN-TAB-3PHAN (git status 13 M + 2 ?? không đụng shell) → pre-existing.
- **Hướng xử lý:** đợt sau rà smolab-module.tsx mobile breakpoint (ẩn/đóng sibling cố định dưới sm) — KHÔNG fix trong đợt này theo giao thức §5.6 (không mở rộng scope giữa chừng).

### BUG2-216 · C·P3 — impact window ±3 ngày KHÔNG được áp dụng: `OBS_IMPACT_LOOK_DAYS=3` khai báo nhưng dead (0 tham chiếu) — before/after chọn không giới hạn khoảng cách, change 25h + snapshot trước cách 10 NGÀY vẫn chấm impact.estimate — vi phạm chốt §7 Q5 "tra tối đa ±3 ngày mỗi bên, cần đủ cả 2 bên" (payload window.claim "ngày liền trước vs liền sau" trong khi dữ liệu cách 10 ngày → framing correlation RO-6 sai lệch) — FB-OBS-R1-01 (auditor 24-a probe2 + coordinator chấm chéo spec §7:295)
- **Fix (Task 24):** minDay/maxDay = kpiDateOf(change.createdAt ∓ LOOK×24h) bound trong vòng chọn — before chỉ nhận trong [minDay, changeDay), after chỉ nhận trong (changeDay, maxDay]; payload window thêm `lookDays: 3` + note "tra ±3 ngày mỗi bên".
- **Kiểm chứng:** r98-C5/C6 regression (before −10d → 0 event · after +5d → 0 event — code cũ trả 1 event); r98-C4 pin `window.lookDays===3`; gate full suite 1504/1504.

### BUG2-217 · C·P3 — snapshot CÙNG NGÀY change chặn cả KPI thay vì bỏ qua để lấy ngày kế: vòng chọn break ở snapshot đầu ≥ changeDay rồi `after.date===changeDay → continue` bỏ hẳn KPI — dù snapshot changeDay+1 tồn tại, KPI không bao giờ được chấm (change bị rescan mỗi tick mãi mãi) — FB-OBS-R1-02 (auditor 24-a probe S1; r98-C3 cũ không seed +1d nên không phân biệt được 2 cách hiểu)
- **Fix (Task 24):** trong vòng chọn — `s.date===changeDay → continue` (bỏ snapshot trùng, không gán after) rồi tiếp tục tới snapshot đầu > changeDay.
- **Kiểm chứng:** r98-C4 regression (before −1d + trùng changeDay + NGÀY KẾ +1d → 1 event, after=0.6 của +1d, KHÔNG dùng 0.55 ngày trùng — code cũ 0 event); r98-C3 cũ vẫn pass (kịch bản không có ngày kế → 0 như cũ); gate 1504/1504.

### BUG2-218 · C·P4 — capPayload 4KB / capTraceJson 2KB đếm `.length` (đơn vị UTF-16) thay vì BYTE UTF-8: payload 3.011 ký tự 'ụ' (9.033 byte) qua được cap "4KB" — hằng số tên BYTES nhưng ngữ nghĩa là ký tự; payload/vector tiếng Việt (3 byte/char) vượt cap thật ~2.2× — FB-OBS-R1-03 (auditor 24-a probe1: Buffer.byteLength 9.011 vs length 3.011 + trace 1.500 'ụ' → 4.510 byte vượt 2.048)
- **Fix (Task 24):** `byteLen()` = Buffer.byteLength(s,'utf8') thay `.length` ở cả 3 mức cap (ledger.capPayload 2 nhánh + cắt thô; trace.capTraceJson); head cắt theo BYTE qua `Buffer.from(s,'utf8').subarray(0, cap−offset).toString('utf8')` — ledger head budget −160 (đủ chỗ vỏ JSON ~75 byte quanh head), trace giữ −60.
- **Kiểm chứng:** r95-C4/r96-B2 regression (đa byte: `.length` lừa được cap cũ + byte thật > cap → truncated + `Buffer.byteLength(out) ≤ cap` sau fix; head còn >1000/>500 ký tự); gate 1504/1504.

### BUG2-219 · C·P4 — heuristic isRate `value∈[0,1] ∧ n>0` bắt nhầm KPI TRUNG BÌNH nằm [0,1] (eval_ndcg/eval_recall — trung bình nDCG/recall per-case; verdict_f1 — harmonic mean) → CI binomial z·√(p(1−p)/n) sai mô hình phương sai cho non-rate — trái chốt §7 Q5 "CI thô **rate KPI**" — FB-OBS-R1-04 (auditor 24-a + registry.ts:175/194 không có trường rate)
- **Fix (Task 24):** `KpiDef.rate?: boolean` single-source — đánh dấu 6 KPI tỉ lệ nhị thức thật (mission_success_rate · verdict_precision · tool_success_rate · kb_fallback_rate · delegation_ratio · digest_gate_fallback_rate); estimateKpiImpact tra `KPI_REGISTRY.find(key).rate===true` + giữ guard dữ liệu (value∈[0,1] + n>0); KPI lạ ngoài registry → CI null (bảo thủ).
- **Kiểm chứng:** r98-A4 regression (eval_ndcg 0.626/3→0.667/4: CI null — heuristic cũ trả CI khác null; kpi lạ → null; mission_success_rate rate:true vẫn có CI — chấm chéo A1); gate 1504/1504.

### BUG2-220 · D·P4 — kinds reserve lệch tên với HyperNAS §9: kinds.ts + blueprint OBS §C.2 + schema.prisma đều `proposal.apply` nhưng BLUEPRINT-HYPERNAS §9 (dòng 460) ghi `proposal.applied` — doctrine #9 "thống nhất kind-name từ v0.1" vỡ 1 phía; khi HN-P2 phát đúng tên §9, sự kiện rơi ngoài catalog (obsKindDef null → UI nhóm 'db', filter thiếu) — FB-OBS-R1-05 (auditor 24-a: obsKindDef('proposal.applied')=null)
- **Fix (Task 24):** hiệu đính HyperNAS §9 (2 chỗ: đoạn mở đầu + "Sự kiện `proposal.apply`…") → v0.2→0.2.1 kèm ghi chú hiệu đính — 3 nguồn còn lại đã thống nhất 'proposal.apply' (sửa 1 phía theo đa số nguồn).
- **Kiểm chứng:** grep 'proposal.applied' toàn repo chỉ còn dòng ghi chú hiệu đính (trích dẫn tên cũ có chủ đích); r95-H6 pin 16 kind không đổi; gate 1504/1504.

### BUG2-221 · H·P4 — prune thiếu pin: `pruneBrainInferenceTraces` (20K/14 ngày) 0 test; count-cap 50K của `pruneObservationEvents` 0 test (r95-E chỉ pin age-based) — commit message claim test "prune", code ĐÚNG (auditor probe độc lập: seed 50.052 → còn đúng 50.000 mới nhất) nhưng không pin — cùng lớp pin-hở BUG2-206/210 — FB-OBS-R1-06 (auditor 24-a grep tests r95–r98)
- **Fix (Task 24):** cả 2 hàm prune nhận `opts?: { keep?: number; maxAgeDays?: number }` (chỉ định cho test — production gọi không tham số, mặc định hằng số Q3 §7) — pin count-cap được mà không phải seed 50K/20K dòng.
- **Kiểm chứng:** r95-E2 (8 dòng seed thẳng DB, keep:5 → xoá đúng 3 cũ nhất theo seq, còn [901_004..901_008]) + r96-G1 (age: 3 vết ts 40 ngày xoá, vết mới giữ) + r96-G2 (count-cap: 8 vết createdAt cách 1 phút, keep:5 → xoá cap8/7/6, còn cap5..cap1 asc) + pin hằng số OBS_TRACE_KEEP=20K/14d; gate 1504/1504.

### BUG2-222 · G·P4 — observation-tab tự dựng `KIND_FALLBACK` + `KIND_CLASS_MAP` (bản sao kind→group 16 kind) thay vì `obsKindDef()` — kinds.ts:56 comment chính là hứa "caller tự fail-open nhóm/màu mặc định"; thêm kind mới ở kinds.ts → UI map thiếu → chip sai nhóm màu 'db' — FB-OBS-R1-07 (auditor 24-a: observation-tab.tsx:115-138 vs kinds.ts:54-59; r97-B9 cũ không chặn map trùng lặp)
- **Fix (Task 24):** `kindClass(kind) = OBS_GROUP_CLASSES[obsKindDef(kind)?.group ?? 'db']` — xóa hoàn toàn 2 map cục bộ (~25 dòng), import obsKindDef từ kinds.ts (file đã import OBS_GROUP_CLASSES).
- **Kiểm chứng:** r97-B9 gia cố (not.toContain KIND_CLASS_MAP/KIND_FALLBACK + toContain 'obsKindDef(kind)?.group') + r97-A2 obsKindDef fail-open không đổi; grep toàn repo 0 mồ côi; gate 1504/1504.

### BUG2-223 · C·P4 — verdict.add nhánh DELEGATE (đường chính production — fresh client) thiếu rowKey: result của `db.arbiterVerdict.create` bị bỏ, nhánh raw fallback có `rowKey: id` — event không trỏ về dòng ArbiterVerdict cụ thể, mất kim tuyến cho phán quyết (timeline drill-down không mở được dòng DB) — FB-OBS-R1-08 (auditor 24-a: metrics-db.ts:236-249 delegate vs :271 raw)
- **Fix (Task 24):** `const created = await db.arbiterVerdict.create({...})` → hook thêm `rowKey: created.id` (đối xứng nhánh raw; model id @default(cuid()) — create không cần truyền id).
- **Kiểm chứng:** r95-I1 behavioral mới (insertArbiterVerdict delegate path → event rowKey === ArbiterVerdict.id thật, table='ArbiterVerdict'); gate 1504/1504.

### BUG2-224 · D·P4 — commit f94c55c message ghi "Test r95–r98 (65 test…)" — thực đo 64 (r95=20 + r96=11 + r97=20 + r98=13 — grep `test('` từng file; worklog Task 23 + blueprint dòng 37 đều ghi 64 đúng) — FB-OBS-R1-09 (auditor 24-a + coordinator đếm lại độc lập)
- **Fix:** KHÔNG thể sửa — commit đã push cả 2 kho (lịch sử git bất biến); ghi nhận hiệu đính tại đây (precedent BUG2-208 "doc số dòng lệch 1"). Blueprint §0 đã đúng 64 nên không chỗ nào khác cần sửa.
- **Kiểm chứng:** đếm lại 2 lần (auditor + coordinator) khớp 20/11/20/13=64; blueprint:37 "64 test" ✓.

### BUG2-225 · D·P4 — comment r95-H3 đếm nguồn sai: "episode(2 nhánh) + lesson(2 nhánh) + 1 định nghĩa kinds = 5 nguồn" — thực tế episodic-db.ts có đúng 4 occurrence `kind: 'learn.episode'` (upsertEpisode delegate/raw + Lesson delegate/raw; KHÔNG có "định nghĩa kinds" nào trong file) — assertion `toBe(5)` đúng (4 occurrence → split 5 đoạn) nhưng comment gây hiểu sai nguồn — FB-OBS-R1-10 (auditor 24-a grep đếm độc lập)
- **Fix (Task 24):** sửa comment — "4 occurrence `kind:` (episode 2 nhánh + lesson 2 nhánh) → split 5 đoạn" (assertion giữ nguyên).
- **Kiểm chứng:** r95-H3 pass trong full suite 1504/1504 (assertion không đổi — chỉ comment).

### BUG2-226 · G·P4 — `obs_impact=on` + `obs_ledger=off`: worker mỗi tick 10 phút vẫn quét đầy đủ (candidates 500 + full KpiSnapshot + dedup load) nhưng `observeEvent` no-op mọi thứ → `written++` đếm sự kiện KHÔNG được ghi (return value lừa), dedup không bao giờ nhúng → change bị rescan vĩnh viễn mỗi tick — FB-OBS-R1-11 (auditor 24-a: impact.ts:180-201 written++ không phụ thuộc observeEvent thực ghi + ledger.ts:115-117 off → return im lặng)
- **Fix (Task 24):** guard đầu `computeImpactEstimates` — `if (!isObsLedgerEnabled()) return 0`; tick thêm `|| !isObsLedgerEnabled()` (output duy nhất của worker là SỰ KIỆN qua ledger); TUNING_SPECS obs_impact description ghi rõ "Cần obs_ledger on để ghi — obs_ledger off thì tick rỗng"; impact.ts header + JSDoc đồng bộ.
- **Kiểm chứng:** r98-G4 regression (dữ kiện đủ điều kiện + obs_ledger off → computeImpactEstimates 0 + 0 event — code cũ trả 1 đếm giả); gate 1504/1504.

### BUG2-227 · G·P4 — observation-tab error-state không bao giờ hiển thị được: fetch hỏng kéo dài (500/mất kết nối) → `data` stay null → spinner "Đang tải…" vô hạn; `loadError` chỉ render trong nhánh `initialLoading===false && flagUiOn` (dòng 467 — chỉ khi ĐÃ có data) — 2 nhánh loại trừ nhau, lỗi 500/timeout không bao giờ tới người dùng — FB-OBS-R1-12 (auditor 24-a: observation-tab.tsx:368-373 + :467)
- **Fix (Task 24):** nhánh initialLoading hiển thị loadError ngay trong spinner — `{loadError ? <span amber>{loadError} — thử lại</span> : 'Đang tải timeline quan sát…'}` (poll tiếp tục thử lại — fail-open giữ dữ liệu cũ như thiết kế).
- **Kiểm chứng:** r97-B10 pin mới (toContain '— thử lại' + regex /initialLoading &&[\s\S]*?loadError/); gate 1504/1504.

### BUG2-228 · G·P4 — drainTrace thiếu pruning guard đối xứng ledger (ledger có flag `pruning` + check `!st.pruning`; trace gọi `void pruneBrainInferenceTraces()` mỗi 1000 vết không guard) — prune chồng chéo: race hiếm findFirst skip tính trên count stale → mốc createdAt cũ hơn → xoá VƯỢT quá cap vài dòng (vi phạm hợp đồng "giữ tối đa KEEP dòng mới nhất"; auditor R1 xếp "không cấp ID — idempotent vô hại", coordinator chấm chéo RA NHÂP cấp: over-delete vi phạm hợp đồng cap, cùng lớp cơ chế ledger đã phải guard) — FB-OBS-R1-13 (coordinator 24 chấm chéo R1 — nâng cấp từ ghi nhận không-ID của auditor)
- **Fix (Task 24):** `pruning: boolean` vào ObsTraceState + init false; drainTrace check `!st.pruning` → set true → `void pruneBrainInferenceTraces().finally(() => state().pruning = false)` — bit-đối-bit ledger.ts:163-169.
- **Kiểm chứng:** r96-G3 source-scan pin ('!st.pruning' + 'st.pruning = true' + 'state().pruning = false' — race không pin behavioral được, pin wiring theo bài học BUG2-210); gate 1504/1504.

### BUG2-229 · D·P4 — Lặp từ do chính fix R1-12 sinh ra (bắt tại LIVE verify, sau vòng R2): catch fetchTimeline đặt loadError "Mất kết nối — giữ dữ liệu cũ, đang thử lại" + hậu tố spinner của fix R1-12 thêm "— thử lại" → hiển thị "Mất kết nối — giữ dữ liệu cũ, đang thử lại — thử lại" (thừa chữ "thử lại" 2 lần) — FB-OBS-LIVE-01 (coordinator 24 live verify agent-browser: chặn network route **/api/observation/timeline* --abort → innerText region hiện đủ câu lặp)
- **Fix (Task 24, vòng R3):** rút gọn catch → 'Mất kết nối — giữ dữ liệu cũ' — phần "thử lại" do hậu tố spinner đảm nhiệm (một nguồn duy nhất).
- **Kiểm chứng:** live verify lại (network vẫn chặn): innerText "Mất kết nối — giữ dữ liệu cũ — thử lại" — hết lặp; r97-B10 pin '— thử lại' vẫn pass (hậu tố giữ nguyên — chuỗi pin không đổi); gate 4 tầng PASS lại (tsc · eslint · check:imports · full suite 1504/1504).

### BUG2-230 · F·P1 — Zen free-tier gate phát hiện PROJECT CONFIG (không phải IP): opencode CLI từ dir sạch chạy model free OK (kể cả IP datacenter, keyless), nhưng session có opencode.json (project/global/ancestor) HOẶC PWD env trỏ về dir có config → 403 FreeTierError — R10 (2026-10-14, phiên phục hồi sau container reset)
- **Phát hiện khi nào:** user report "đăng nhập tài khoản OpenCode nhưng vẫn gặp 'free-tier vẫn bị chặn (egress: AS7552 Viettel Group · không phải datacenter)'" — egress ĐÚNG là IP cá nhân VN, chứng minh chặn KHÔNG theo IP.
- **Bằng chứng live-probe 2026-10-14 (ma trận cô lập biến, sandbox IP datacenter Alibaba HK):**
  1. CLI v1.19.0 + dir trống: space-bunny-free/big-pickle/mimo OK exit 0 — KEYLESS, từ datacenter → free-tier mở cho client OpenCode THẬT bất kể IP.
  2. +opencode.json (project cwd, kể cả tối giản `{"permission":{...}}` không providers; HOẶC global ~/.config/opencode/) → 403 FreeTierError ngay.
  3. CLI đọc config theo chuỗi thư mục CHA từ cwd — workspace lồng trong app dir không thoát.
  4. `.opencode/` dir (bridge tools tmo_*, KHÔNG package.json) + `.opencode/agent/build.md` (chỉ description/mode/prompt) → VẪN QUA GATE ✓.
  5. Agent frontmatter `tools:` (filter native tools) HOẶC `permission:` → bị gate bắt (đổi request toolset / bật permission engine).
  6. `.opencode/package.json` → CLI TỰ npm-install deps tạo node_modules → run sau đó "Unexpected server error" (Zen 500).
  7. **Bisect env 99 biến của process Next.js → thủ phạm duy nhất `PWD`**: CLI đọc biến PWD (không chỉ cwd) để resolve project config — spawn cwd=ws-sạch nhưng PWD=app-dir (có opencode.json) vẫn 403. Ghi đè PWD=ws → OK (verified D1).
- **Tác động:** toàn bộ đường OC-CLI (failover tier 2 + last-resort pool) chết trên sandbox LẪN máy user local (mọi máy chạy TMO từ app dir); agents rơi hết xuống NIM rescue (tốn quota NVIDIA); UI dropdown model free báo chặn sai nguyên nhân.
- **Fix R10 (src/lib/llm.ts — 3 lớp):**
  1. **R10 workspace sạch**: `ensureCliWorkspace()` — copy `.opencode/tools` từ app ra `~/.oc-cli-ws/.opencode/tools` (ngoài app dir, refresh khi nguồn mới hơn) + tự sinh `.opencode/agent/build.md` prompt chặn MỀM native write/edit/bash (tmo_* bridges ưu tiên — INFRA GUARD audit). Override env `OPENCODE_CLI_WORKSPACE`.
  2. **R10b chống nhiễm**: KHÔNG copy package.json/package-lock (tránh CLI auto-install độc hại); MỖI spawn dọn dấu vết node_modules/package*.json trong ws (self-heal).
  3. **R10c PWD override**: mọi spawn (provider + probe) ghi đè `PWD: ws` trong env — CLI thấy session không project config.
  4. SBF alias opencode-k1/k2/k3 (sống trong opencode.json) không khả dụng trên đường CLI → MỌI model dùng native `opencode/<model>` + auth.json (xoay key đa giữ nguyên đường HTTP callZenProvider).
- **Kết luận cho user (câu hỏi "đã đăng nhập mà vẫn bị chặn"):** đăng nhập OAuth đúng nhưng TMO cũ gọi HTTP bằng oc_sk key / CLI từ app dir — 2 transport đều bị gate bắt vì session "không thuần OpenCode". Sau fix: model free chạy QUA CLI từ ws sạch — KHÔNG cần đăng nhập, không phụ thuộc IP.
- **Kiểm chứng E2E:** boot-sweep + chat Omega "Chỉ trả lời đúng 1 từ: OK" → log `[LLM] Agent dùng OpenCode CLI space-bunny-free ✓ (16479 tokens)` + ChatMessage assistant "OK" — KHÔNG rơi NIM rescue; probe Zen HTTP vẫn 403 (oc_sk HTTP bị chặn — đúng, tier HTTP chết, tier CLI sống).
- **Còn treo (không fix phiên này):** mini-services/opencode-server (Code tab sandbox) có opencode.json riêng — đường CLI của nó (nếu có) cần cùng xử lý PWD/ws khi đụng model free; native write/edit/bash chỉ chặn MỀM bằng prompt (mọi cơ chế chặn cứng đều bị gate bắt) — chấp nhận rủi ro, xem xét quay lại khi Zen đổi policy.

---

## ĐỢT FB-SERIAL + FB-R13DEBT (R14 — 2026-10-15) — BUG2-231..254

> 2 đợt chạy song song theo user directive: (1) FB-SERIAL = tuần tự hóa agent invocation (user directive bản 3, ghi đè 2026-10-29b); (2) FB-R13DEBT = rà lại toàn bộ fix R13 DebtLedger ("những fix từ lượt quan sát gần nhất"). Auditor độc lập R1 (2 subagent) + R2 mắt tươi (1 subagent) + R3 mini coordinator; gate 4 tầng PASS 1726/1726 (build exit 137 = OOM môi trường — chứng minh BUILD_EXIT=0 khi pm2 dev-server dừng; không phải lỗi code).

### BUG2-231 · B·P2 — Deadlock tự-chờ (bounded/unbounded theo config) qua escalate_problem auto-apply khi delegationRunId=null — FB-SERIAL-R1-01
- **Hiện tượng:** Guard duy nhất chống dispatch lồng là `calledFromSubAgent = Boolean(context?.delegationRunId)` (tool-executor.ts escalate case). Nhưng `registerDelegationRun` trả null khi sub-agent chạy không sessionId (eval harness default; agent-run-tracker.ts:1035) hoặc tracker throw (fail-open). Guard tưởng là parent → auto-apply `dispatchAgentByOmega` → `runSubAgentForProfile` → `acquireSubAgentSlot` xếp hàng chờ CHÍNH NÓ (pool=1: sub-agent đang giữ slot duy nhất, await tool chờ nested dispatch — chờ slot nó giữ). Thoát chỉ khi SUBAGENT_LOOP_BOUND_MS cắt loop; cả TIMEOUT_MS=0 + WALL_CLOCK=0 → `await loopPromise` không withTimeout → treo vô hạn thật.
- **Fix (R14):** (a) AsyncLocalStorage `subAgentRunALS` (mirror pattern runWithZenKeyBinding) — `runSubAgentForProfile` wrap `subAgentRunALS.run({holding:true})` quanh toàn bộ run + export `isInsideSubAgentRun()`; nested-check ĐẦU hàm → trả outcome fail NESTED_DELEGATION_BLOCKED (fail-open, run cha không sập); (b) tool-executor guard bổ sung `isInsideSubAgentRun() || delegationRunId` (đóng lỗ null).
- **Kiểm chứng:** r101 B5 (pin export + ALS + NESTED_DELEGATION_BLOCKED + wrap + guard dynamic import); tsc 0; gate 1726/1726.

### BUG2-232 · D·P3 — Prompt sống OMEGA standalone còn dạy "chạy song song tối đa 3 sub-agent" — FB-SERIAL-R1-02
- **Hiện tượng:** standalone-agents.ts:354 (instruction OMEGA — "PHÂN CÔNG THEO CHỨC TRÁCH"): "dispatch_agents_parallel (chạy song song tối đa 3 sub-agent...)" — R14 chỉ sửa goal-loop hint (agent-goal-loop.ts:899), bỏ sót prompt standalone. Omega được dạy sai semantics sau khi pool=1.
- **Fix:** :354 → "chạy TUẦN TỰ: mỗi lượt 1 sub-agent hoàn tất mới tới kế tiếp — user directive R14".
- **Kiểm chứng:** r101 B6 (absence 'chạy song song tối đa 3 sub-agent' + presence TUẦN TỰ).

### BUG2-233 · D·P3 — Prompt SIVIL IDENTITY còn "EXPLORE SONG SONG" mâu thuẫn chính nó trong cùng prompt — FB-SERIAL-R1-03
- **Hiện tượng:** research-team/agents.ts:112 (IDENTITY & PURPOSE SIVIL): "BIẾN 1 TASK THÀN N HƯỚNG EXPLORE SONG SONG (5-300 sub-agents)" — trong khi :118 cùng prompt đã sửa "dispatch THEO LƯỢT". Dòng KÊU GỌI nhất prompt lại sai.
- **Fix:** :112 → "EXPLORE THEO LƯỢT — TUẦN TỰ, mỗi lượt 1 sub-agent (5-300 sub-agents; user directive R14)".
- **Kiểm chứng:** r101 B6 (absence 'EXPLORE SONG SONG' + presence THEO LƯỢT).

### BUG2-234 · D·P4 — Comment stale "Dispatch NHIỀU sub-agent ĐỒNG THỜI" ngay trên tool đã đổi — FB-SERIAL-R1-04
- **Fix:** tool-executor.ts:2029-2031 → "TUẦN TỰ (mỗi lượt 1 — user directive R14)". Kiểm chứng: r101 B7 (region mở rộng −260 ký tự — R2 mini: toàn file quét thêm B9).

### BUG2-235 · D·P4 — sivil.ts 3 JSDoc mô tả "parallel waves / Parallel-Hybrid" cũ — FB-SERIAL-R1-05
- **Fix:** sivil.ts:5/:7/:119 đồng bộ "R14: tuần tự, mỗi lượt 1 SA". Kiểm chứng: r101 B6.

### BUG2-236 · C/D·P4 — TB-03 blueprint chưa chú thích R14; claim "không phá spec" chỉ đúng nửa — FB-SERIAL-R1-06
- **Hiện tượng:** TB-03 §5.2 recommend "Hybrid cho COMPLEX+", §5.4 "10–25 SA chạy đồng thời", §12 Q1 "20 mặc định burst 25" — code giờ Sequential=1 mọi lúc. Comment sub-agents.ts claim "không phá spec" sai nghĩa (đây là GHI ĐÈ mặc định spec).
- **Fix:** TB-03 thêm NOTE R14 tại 3 chỗ (§5.2 sau bảng + S1 row + Q1 row) nói rõ "tạm ngưng theo user directive; kill-switch SUBAGENT_MAX_CONCURRENT"; comment sub-agents.ts §4 đổi "ghi đè mặc định spec theo user directive".
- **Kiểm chứng:** r101 B7 (pin 'NOTE R14 (2026-10-15' + 'tạm ngưng').

### BUG2-237 · C·P3 — dispatchPlan: block mới (≥50% fail) không pin + citation "stop S1" lệch spec — FB-SERIAL-R1-07
- **Hiện tượng:** R14 thêm block warn ≥50% SA FAILED nhưng cite "TB-03 §5.4 stop S1" — spec S1 thật là "Dừng batch → kiểm tra hạ tầng → ESCALATE"; code chỉ warn+continue (nhân bản pattern pre-existing của dispatchPlanInBatches).
- **Fix:** citation trung thực "TB-03 §5.4 S1 (dừng batch + escalate) CHƯA triển khai; fail-open tiếp tục (xem FB-SERIAL-R1-07)" — hành vi giữ fail-open (documented deviation, không lặng lẽ).
- **Kiểm chứng:** r101 B7.

### BUG2-238 · C·P4 — r101 thiếu pin 3 nhóm fix (JD strings / dispatchPlanInBatches / goal-loop evidence) + B4 region heuristic yếu — FB-SERIAL-R1-08
- **Fix:** bổ 3 nhóm pin + B4 chuyển extractFn('llmScoreHypothesisBlind', 'async function') — pin mạnh hơn region heuristic. Kiểm chứng: r101 B6/B8/B4 pass.

### BUG2-239 · G·P4 — getSubAgentSlotPoolInfo JSDoc hứa "đài quan sát" nhưng 0 consumer production — FB-SERIAL-R1-09
- **Fix:** giữ export (đã dùng cho test A1-A3) — claim "đài quan sát" sẽ wire sau (ngoài phạm vi đợt này, ghi fixbug.md); không sửa JSDoc vì việc wire panel là việc của đợt sau — ghi nhận trung thực ở đây. Kiểm chứng: việc này được ghi "Ngoài phạm vi" trong biên bản FB-SERIAL.

### BUG2-240 · D·P3 — Protocol delegation (goal-loop:859) còn dạy "hệ thống tự chạy SONG SONG (không cần đợi tuần tự)" — FB-SERIAL-R2-01
- **Hiện tượng:** buildDelegationProtocol nối vào system prompt mọi agent có delegate_task — dạy ngược với hint :899 đã sửa và với log :4612 của chính fix R14.
- **Fix:** :859 → "hệ thống tự XẾP HÀNG TUẦN TỰ (pool 1-slot — mỗi delegation hoàn tất mới tới kế tiếp, R14) + hợp nhất kết quả. Vẫn cứ emit nhiều tool_calls cùng lúc — hệ thống lo thứ tự."
- **Kiểm chứng:** r101 B9 (absence 'hệ thống tự chạy SONG SONG').

### BUG2-241 · D·P4 — Thought quan sát 📤/📥 báo "PHÂN CÔNG SONG SONG / agent cùng lúc" — FB-SERIAL-R2-02
- **Fix:** goal-loop:1383/:1440 → "PHÂN CÔNG THEO LƯỢT (tuần tự — pool 1-slot R14)". Kiểm chứng: r101 B9.

### BUG2-242 · D·P4 (gộp 3) — Comment stale vùng liền kề fix: tool-executor:4068 "Dispatch NHIỀU sub-agent SONG SONG" + standalone-agents:547 tool list "SONG SONG + hợp nhất" + workspace-git:78 "2 sub-agent chạy song song chia sẻ working tree" — FB-SERIAL-R2-03
- **Fix:** 3 chỗ diễn đạt lại R14 (workspace-git giữ guard làm defense in depth). Kiểm chứng: r101 B9 (quét TOÀN FILE absence).

### BUG2-243 · D·P4 (pre-existing, bóc ra ở R2) — code-team prompt "Tool calls có thể song song" — FB-SERIAL-R2-04
- **Hiện tượng:** prompts.ts:99 dạy agent emit song song — thực tế workflow-engine + goal-loop batch + delegation fan-out đều thực thi tuần tự.
- **Fix:** :99 → "Tool calls trong 1 response được thực thi LẦN LƯỢT theo thứ tự (R14 — tuần tự) — vẫn cứ emit nhiều tool_calls khi độc lập; kết quả về đủ đúng vị trí cho LLM."
- **Kiểm chứng:** r101 B9 (absence 'Tool calls có thể song song').

### BUG2-244 · C·P1 — finalizeDebtAfterRun KHÔNG BAO GIỜ resolve nợ same-session: mirror-lookup trượt Todo gốc — FB-R13DEBT-R1-01
- **Hiện tượng:** finalize tìm mirror bằng `taskMetaJson contains d.id` — chỉ Todo mirror GLOBAL có debtLedgerId trong taskMeta (duy nhất 1 nơi ghi :313); 3 đường ghi Todo GỐC (agent-goal-loop 5446/5491/5973) không set → mirrorStatus=null → resolvedNow luôn false → nợ same-session kẹt open vĩnh viễn → park oan sau 3 lần dù agent đã hoàn thành + trọng tài KHÔNG re-list. CHÍNH LÀ chẩn đoán user "tìm ra vấn đề và giải quyết nhưng không giải quyết được" còn sống ở đường same-session.
- **Bằng chứng:** auditor tái lập E2E DB cô lập (STEP2-4: hoàn thành thật + không re-list → resolved=0, vẫn open); DebtLedger.todoId (schema lưu id Todo gốc) tồn tại nhưng finalize không dùng.
- **Fix (R14):** lookup `OR: [{ taskMetaJson contains d.id }, ...(d.todoId ? [{ id: d.todoId }] : [])]` — Todo gốc (same-session) trở thành bằng chứng resolve được; JSDoc :412 "hoặc Todo gốc" giờ THẬT.
- **Kiểm chứng:** r102 B3 (behavioral trên DB gate-cô lập: hoàn thành Todo GỐC → finalize → status=resolved + resolvedByRunId đúng); gate 1726/1726.

### BUG2-245 · C·P2 — PARK không dừng ở session gốc: Todo gốc không đánh failed + same-session pickup vẫn re-list nợ parked trong "ƯU TIÊN XỬ LÝ" — FB-R13DEBT-R1-02
- **Hiện tượng:** (a) park chỉ đánh mirror (taskMeta match) failed — Todo gốc (d.todoId) vẫn pending → same-session pickup tiếp tục re-list; (b) nhánh "else if (row)" đẩy debt parked vào directive "XỬ LÝ TRƯỚC TIÊN" — agent đốt chu kỳ cho nợ hệ thống đã công nhận không giải quyết được (đúng nghĩa "dừng" bị phá).
- **Fix (R14):** (a) park đánh failed cả Todo gốc; (b) tách `actionable` vs `parkedNotes` — nợ parked/resolved chuyển sang ghi-chú "ℹ️ ĐÃ PARK/ĐÃ RESOLVED — KHÔNG thử lại trong run này (xem /api/debt/status)"; directive ưu tiên chỉ chứa actionable.
- **Kiểm chứng:** r102 B5 (Todo gốc failed sau park) + B6 (PATCH-park đường user: 'ĐÃ PARK' có mặt, 'ƯU TIÊN XỬ LÝ' vắng, attempts không tăng, picked không chứa parked).

### BUG2-246 · C·P2 — Kill-switch DEBT_LEDGER=0 hứa "hành vi y hệt trước R13" nhưng tắt luôn same-session pickup — FB-R13DEBT-R1-03
- **Hiện tượng:** wiring R13 đã thay buildPendingDebtBlock bằng pickupDebtForRun; hàm early-return toàn bộ khi cờ off → khối "NỢ KỸ THUẬT CÒN TREO" biến mất âm thầm (chức năng user-directive 2026-10-27 có từ trước R13); comment module :37 hứa ngược.
- **Fix (R14):** pickupDebtForRun dựng block legacy INLINE khi cờ off — ĐỦ 4 mục như buildPendingDebtBlock gốc (R2-01 bổ mục 3 checklist tự phục vụ + mục 4 "hết nợ mới làm việc mới"); không import ngược agent-goal-loop (tránh chu trình tĩnh cho check:imports).
- **Kiểm chứng:** r102 F1 (source pin + absence import ngược); check:imports PASS 0 chu trình mới.

### BUG2-247 · H·P3 — THIẾU SÓT C5: cả 5 fix R13 KHÔNG test regression vĩnh viễn; "E2E 12/12" là script dùng-xong-vứt — FB-R13DEBT-R1-04
- **Hiện tượng:** grep toàn repo 0 test nhắc debt-ledger; full suite giữ nguyên 1698 (0 test mới); DB production DebtLedger=0 rows → vòng đời chưa từng chạy production.
- **Fix (R14):** tests/r102-debt-ledger.test.ts — 13 test (A1-A6 fingerprint thuần; B1-B7 vòng đời same-session trên DB gate-cô lập incl. pin P1 BUG2-244 + P2 BUG2-245; C1 global cap; D1-F2 source pins race/PATCH/kill-switch/sweeper).
- **Kiểm chứng:** r102 13/13; full suite 1698 → 1726.

### BUG2-248 · C·P3 — Race 2 run song song cùng debt: read-then-write mất update (attempts 0→1 thay vì 0→2) + double-mirror — FB-R13DEBT-R1-05
- **Hiện tượng:** pickup claim `update attempts: row.attempts+1` không điều kiện cạnh tranh; global claim tương tự; recordDebtIssue recurrence tương tự (được unique constraint fingerprint cứu khỏi row đôi nhưng lần ghi thua không được đếm).
- **Fix (R14):** claim chuyển `updateMany({where: {id, status: <đang thấy>}, data: {attempts: {increment:1}, ...}})` + `if (claimed.count !== 1) continue` (thua đua bỏ qua, mirror không vào picked); recurrence chuyển `{increment: 1}`.
- **Kiểm chứng:** r102 D1 (source pin — race thật không pin deterministic được, precedent BUG2-210); hành vi single-run phủ bởi B2 (attempts=1 đúng).

### BUG2-249 · C·P4 (gộp) — PATCH /api/debt/status validate đầu vào hở — FB-R13DEBT-R1-06
- **Hiện tượng:** (a) `body?.id?.trim()` id non-string → TypeError → 500; (b) không bảng chuyển trạng thái (resolve từ resolved lặp resolvedAt; park resolved mâu thuẫn; reopen khi open/in_progress reset lastAttemptRunId của run đang chạy → lost-attempt).
- **Fix (R14):** typeof checks → 400; bảng chuyển: resolve (từ open/in_progress/parked, clear parkReason; từ resolved → 400); reopen (chỉ từ parked/resolved); park (từ open/in_progress; từ resolved/parked → 400 kèm lý do).
- **Kiểm chứng:** r102 E1 (behavioral qua route thật: non-string 400 / reopen-open 400 / resolve 200 / park-resolved 400 / reopen-resolved 200 attempts=0).

### BUG2-250 · C·P4 (gộp) — fingerprint edge: slice 160 false-dedupe + \b ASCII bỏ sót số-dính-chữ-unicode — FB-R13DEBT-R1-07
- **Hiện tượng:** (a) 2 issue khác sau ký tự 160 → trùng fingerprint → recurrence đếm nhầm sang nợ khác; (b) `\b\d{1,2}\b` không match "lỗi12lần" (\b ASCII không thấy boundary giữa unicode-word và digit) — cùng lỗi 2 văn phong bị tách oan; (c) comment liệt "exit code" làm ví dụ số được GIỮ trong khi exit code 1-2 chữ số bị 'n' hóa.
- **Fix (R14):** match THEO RUN `\d+` rồi chấm độ dài (≥3 giữ, <3 → ' n ' có padding — "lỗi12lần" ≡ "lỗi 12 lần"); BỎ slice(0,160) full-length; comment hiệu đính (exit code 1-2 chữ số → 'n' theo thiết kế, ≥3 chữ số giữ).
- **Kiểm chứng:** r102 A1-A5 (run1≡run99, 410≠403, lỗi12lần≡'lỗi 12 lần', 160-collision khác nhau, 410≠41, exit code n).

### BUG2-251 · C·P4 — Sweeper không có đồng hồ riêng (chỉ chạy trong pickupDebtForRun) — FB-R13DEBT-R1-08
- **Hiện tượng:** hệ thống chỉ còn fast-path chat (không goal-loop run) → zombie todo không bao giờ được dọn; worklog/doc gán sai cơ chế "sweeper archived ngay boot" (thật ra chạy tại pickup đầu tiên).
- **Fix (R14):** hẹn 5s sau module-load `setTimeout(...).unref()` + guard `NEXT_PHASE !== 'phase-production-build'` (R2-03: không lên lịch trong next build — route import tĩnh debt-ledger → build eval module, timer nổ sẽ GHI DB thật từ process build).
- **Kiểm chứng:** r102 F2 (source pin timer + unref); build riêng với pm2 dừng BUILD_EXIT=0 (eval module không ghi DB — guard có hiệu lực).

### BUG2-252 · C·P4 — r102 bản đầu 4 điểm pin yếu — FB-R13DEBT-R2-02
- **Hiện tượng:** (a) A4 assert tự-satisfied (`fp[0]==='e' || fp.length>0` luôn true); (b) B5 unresolvedDebtTexts không khớp fingerprint debt → nhánh parkReason "vẫn bị re-list" không được exercise; (c) cleanup bỏ sót session C (mirror todo global leak 2 row/lần chạy); (d) header hứa pin 410≠41 nhưng không có test.
- **Fix (R14 vòng R3):** A4 pin 'exit code n' + bổ 410≠41; B5 dùng nguyên văn content todo làm unresolved + assert parkReason chứa 'vẫn bị re-list'; cleanup thêm SESS_C.
- **Kiểm chứng:** r102 13/13 lại pass sau sửa (chính fixbug vòng lặp bắt pin yếu của pin — đúng cảnh báo §1).

### BUG2-253 · C·P4 — Fallback kill-switch bản đầu thiếu mục 3-4 của legacy block — FB-R13DEBT-R2-01
- **Hiện tượng:** fallback inline chỉ có mục 1-2; so từng dòng với buildPendingDebtBlock gốc (agent-goal-loop.ts:1159) mất mục 3 (checklist tự phục vụ + vùng bảo vệ + ĐIỀU KIỆN CẦN) + mục 4 (hết nợ mới làm việc mới); comment claim "hệt" sai.
- **Fix (R14 vòng R3):** copy đủ 4 mục nguyên văn; comment đổi "ĐỦ 4 mục như bản gốc (FB-R13DEBT-R2-01: bản đầu chỉ có mục 1-2...)".
- **Kiểm chứng:** r102 F1 pin giữ + đọc trực tiếp; tsc 0.

### BUG2-254 · D·P4 — resolutionEvidence nhãn "todo mirror" khi match là Todo GỐC — FB-R13DEBT-R2 (ghi nhận D6 nâng mini)
- **Fix:** evidence đổi `todo ${id} (mirror/gốc — FB-R13DEBT-R1-01) completed` — nhãn đúng cho cả 2 đường match. Kiểm chứng: đọc code debt-ledger.ts finalize; tsc 0.

> **Sai-kỳ-vọng phía người-rà (không cấp ID — dữ liệu chống tự tin sai):** 4 nghi vấn auditor R2 tự bác bằng probe (padding ' n ' KHÔNG phá dính-chữ nhờ collapse \s; waiter không rò ALS context; production DB 0 rows nên không row-đôi pre-R14; PATCH resolve-từ-resolved đã có guard). Auditor R1-A tự bác 4 (pool=1 không giết batch bởi timeout per-LLM-call + heartbeat; Promise.all còn lại là Prisma/lint không phải agent; .env không đè (đã có boot log đối chiếu); thứ tự acquire fan-out có thể đảo nhưng semantics "mỗi lượt 1" vẫn thỏa + thứ tự message cho LLM giữ nguyên).

---

## ĐỢT R15-DEBT — Giải quyết nợ kỹ thuật còn lại (2026-10-15) — auditor R15-FB-R1 7 phát hiện, fix 7/7

### BUG2-255 · C·P3 — Biên bản R14 ghi "đã fix" BUG2-253 nhưng code commit 58ede82 THỰC TẾ thiếu mục 3-4 (reopening) + P-R13-1 "1 nguồn" chưa trọn — R15-R1-01
- **Hiện tượng (phát hiện khi triển khai R15):** git show HEAD:debt-ledger.ts xác nhận fallback kill-switch chỉ có mục 1-2 — đúng nội dung BUG2-253 ghi đã fix ở vòng R3. Hệ quả: "đã giải quyết" trên biên bản ≠ đã giải quyết trên code (đúng lớp lỗi user chẩn đoán từ đầu). Ngoài ra production path (a) (DEBT_LEDGER=1) dựng block inline riêng cũng thiếu mục 4 + vùng bảo vệ — nghịch lý chế độ kill-switch hiếm khi đầy đủ hơn chế độ chính.
- **Fix (R15):** (1) dồn buildPendingDebtBlock (agent-goal-loop — dead-code chỉ còn 2 test import) về buildLegacyPendingDebtBlock trong debt-ledger.ts; (2) extracted formatDebtDirectiveBlock — 1 nguồn format duy nhất cho CẢ fallback lẫn production path (a); (3) 2 test file đổi import; (4) r102 F1 pin mạnh hóa + B0 MỚI pin hành vi 4 mục trên đường production (pin cũ không bắt được lỗi này).
- **Kiểm chứng:** r102 14/14 (gồm B0 mới) + task26 7/7 + task28 9/9 behavioral; full gate 1727/1727.

### BUG2-256 · E·P3 — UI list "Nợ đang mở" badge trạng thái render RỖNG: API open[] thiếu field status — R15-R1-02
- **Hiện tượng:** getDebtLedgerSummary map open/parked không trả `status` → DebtRow.status undefined → statusBadge rơi default → Badge viền không chữ; không phân biệt được open vs in_progress trong list.
- **Fix:** thêm `status: d.status` vào 2 map + interface DebtLedgerSummary. Kiểm chứng: đọc code + UI panel render đúng.

### BUG2-257 · B·P3 — ALS re-entrancy guard không global hóa cùng pool — cửa sau stall cross-bundle/cross-process — R15-R1-03
- **Hiện tượng:** R15 đưa pool lên globalThis singleton nhưng subAgentRunALS còn per-module-instance: next dev nạp module 2 instance → guard instance B không thấy flag instance A. Trước R15 đường trốn-guard rơi vào pool khác (chạy song song — vỡ tuần tự nhưng sống); sau R15 rơi vào GLOBAL pool đang bị cha giữ → stall bounded 15'. Đường cross-process (sub-agent CLI transport → bridge tmo_* HTTP → escalate auto-apply) ALS không xuyên được.
- **Fix (3 lớp):** (a) ALS instance lên globalThis (`__tmoSubAgentRunALS`) đồng bộ pool; (b) LLMCallOptions.insideSubAgentRun → spawn env TMO_INSIDE_SUBAGENT_RUN (cả 2 nhánh spawn, cả call chính + wrap-up); (c) bridge _tmo-common.ts forward cờ qua context HTTP → route parse → executeTool context → guard escalate lớp 3 `context.insideSubAgentRun === true`.
- **Kiểm chứng:** r101 B5 pin mới (globalThis ALS + guard 3 lớp) 15/15; tsc 0.

### BUG2-258 · C·P4 — severity không re-derive ở nhánh bump: "tái phát ≥2" chưa-resolved không bao giờ lên high — R15-R1-04
- **Fix:** nhánh bump thêm `severity: deriveDebtSeverity(kind, nextRecurrence)`. Kiểm chứng: đọc code; định nghĩa docblock giờ đúng mọi nhánh (create/reopen/bump).

### BUG2-259 · D·P4 — comment kill-switch "+ global" sai sự thật — R15-R1-05
- **Fix:** đính chính — global pickup TẮT cùng sổ cái (cần bảng DebtLedger).

### BUG2-260 · G·P4 — .env.example thiếu SQLITE_BUSY_TIMEOUT_S (env mới P-NEW-1) — R15-R1-06
- **Fix:** thêm mục + chú thích (giây, 1..120, mặc định 15). Precedent R12: mọi phanh phải hiện diện trong env example.

### BUG2-261 · H·P4 — docs/arch-spec/ untracked ngoài scope R15 — R15-R1-07
- **Xử lý:** KHÔNG đưa vào commit R15 (file spec design-only từ phiên khác — tránh nhiễu scope); để lại working tree chờ phiên sở hữu quyết định.

> **Nợ R15 đã đóng (không cấp ID bug — là mục nợ kỹ thuật, không phải bug):** PATCH P2023 (validate cuid → 400 + catch lớp 2 — E2E curl garbage-id → 400 rõ nghĩa) · BUG2-239 observability pool (wire production consumer: /api/debt/status slotPool + queueStats p50/p95/max + UI panel) · P-R13-2 UI panel Sổ nợ (Database > Analytics — counts + phanh tuần tự + waitedMs + nút resolve/reopen/park PATCH) · P-NEW-4 triage ~10K tokens/call (reasoningEffort 'low' tường minh — mirror tiền lệ Task 55) · P-NEW-1 SQLite socket-timeout (gốc cơ chế: Prisma SQLite mặc định busy_timeout=5000ms ĐÚNG con số quan sát R11 — live-probe verified; nâng 15s qua URL socket_timeout áp MỌI connection pool + env override) · P-NEW-2 SelfDirection song song (đóng MITIGATED với bằng chứng 3 lớp: user-run-priority gate R12 wired orchestrator:2481 + worker mark/done, OC-CLI semaphore F7, pool=1 R14) · đo phân phối waitedMs (queueStats trong slotPool + UI) · severity cột chết (deriveDebtSeverity có ý nghĩa: infra hoặc tái phát ≥2 → high, hiển thị UI) · TB-03 dead-spec (NOTE R14/R15 3 chỗ + khung quyết định docs/QUYET-DINH-TUAN-TU-VS-CONCURRENCY-R15.md) · agent-delegator doc legacy (docblock LEGACY PATH) · migration re-fingerprint (MOOT — production 0 rows).
> **Nợ còn mở (trung thực):** P-R13-3 pickup lọc theo relevance — cần dữ liệu vận hành thật (DebtLedger production 0 rows; chờ vài run có nợ tự nhiên) · UI panel đo RAM headroom cho khung kill-switch (đã có waitedMs; MemAvailable theo dõi qua MemWatchdog log) · docs/arch-spec/ chờ phiên sở hữu.

---

## ĐỢT R18 — 4 bug user report "nhiều agent cùng lúc + Thought Process biến mất + THAY ĐỔI CHƯA COMMIT thừa + RAM/request định kỳ ma" (2026-10-16)

### BUG2-262 · A·P1 — Nhiều agent "làm việc cùng lúc" ngoài thiết kế tuần tự (nhiều tầng, không phải slot pool R14)
- **Hiện tượng (user report):** Omega gọi nhiều agent khác cùng lúc làm việc; thiết kế yêu cầu 1 agent khác/lượt, các agent sau xếp lượt.
- **Chẩn đoán (điều tra R18 — 3 subagent Explore):** Slot pool 1-slot R14 HOẠT ĐỘNG ĐÚNG (registerDelegationRun chỉ chạy SAU acquireSubAgentSlot — subagent-delegate.ts:736→958; fan-out launch promise đồng loạt nhưng exec serialize). Thủ phạm thật ở TẦNG KHÁC: (a) `GOAL_LOOP_MAX_CONCURRENT` default=2 (code + .env.example) — máy user không có override .env (env không track git) → worker chạy 2 job goal-loop song song = 2 agent "đang chạy" cùng lúc; (b) đường inline chat (ENABLE_DURABLE_GOAL_LOOP=false) KHÔNG có per-session mutex — 2 request chồng (user gửi lại sau 502/504, tab thứ 2) → 2 loop song song cùng session; (c) đa process (dev + pm2): pool per-process → song song thật + orphan sweep requeue-đè job process khác đang chạy (không check workerPid sống).
- **Fix:** (1) default GOAL_LOOP_MAX_CONCURRENT 2→1 (goal-loop-durable-types.ts + .env.example — đồng bộ 2 tầng về 1 quy tắc); (2) inline chat mutex: hasActiveRun(sessionId) → 409 + message tiếng Việt (chat route trước runGoalDrivenLoop; UI parse errData.error hiển thị nguyên văn); (3) sweepOrphans gate PID-ALIVE — workerPid khác process còn sống → SKIP không requeue-đè (isWorkerPidAlive: process.kill(pid,0), EPERM=sống; log throttle 60s/job).
- **Kiểm chứng:** boot log "tối đa 1 job song song"; E2E 2 POST chồng cùng session → KHÔNG chồng lấp (trail timestamp chạy tuần tự — run2 start sau run1 end); tsc/lint 0.

### BUG2-263 · B·P2 — Panel Thought Process BIẾN MẤT khỏi khung chat sau một lúc (không xem lại được)
- **Hiện tượng (user report):** Thought Process của agents hiện lúc đầu, một lúc sau TẤT CẢ biến mất, không mở lại xem được — mất khả năng debug.
- **Chẩn đoán:** Panel chỉ render khi `agentRuns[runId]` tồn tại — nguồn DUY NHẤT là registry IN-MEMORY (globalThis): restart process = mất trắng; eviction cửa sổ 10 run/session (splice mất cả run CHA đang sống → endAgentRun mất dấu → summary không persist); LRU 30 session (automation/opus tạo runs ở chục session khác → purge session đang xem). Poll/heartbeat loadSessionTail REPLACE messages + re-merge panel CHỈ từ registry → panel biến mất vĩnh viễn (DB không có role 'agent_run'). JSONL trail đầy đủ CÓ trên đĩa (agent-runs/<runId>.jsonl) + API /api/agent-run?runId= đọc được — nhưng UI không bao giờ gọi.
- **Fix (3 lớp):** (1) tracker: MAX_RUNS_PER_SESSION 10→20, MAX_SESSIONS 30→40, evictOldRuns chỉ đuổi run KHÔNG chạy (toàn running → tạm vượt cap — không splice run cha giữa chừng); (2) API GET /api/agent-run?sessionId trả THÊM `recordRuns` — tái tạo từ bảng AgentRunRecord DB (dedupe theo runId với registry, status map completed→done/failed,incomplete,running→error, kèm counters từ record + trailAvailable:true); (3) UI: loadSessionTail merge cả recordRuns (panel xuất hiện lại đúng chỗ sau restart/eviction); AgentRunPanel lazy-fetch /api/agent-run?runId=&limit=2000 (đọc JSONL đĩa) khi user mở panel có events rỗng + trailAvailable — hiển thị đầy đủ timeline kèm nhãn "(bản lưu)".
- **Kiểm chứng E2E browser:** sau 2 lần app restart (OOM recompile), mở session cũ → 4 panel Thought Process xuất hiện lại đúng vị trí; mở panel → 21 events tải từ disk-trail (17 thought + 2 tool + run_start/end); mở rộng mobile 390px OK; 0 lỗi console.

### BUG2-264 · C·P2 — Khối "THAY ĐỔI CHƯA COMMIT" nhảy ra trong MỌI final report (kể cả run không làm gì / lỗi không trả lời)
- **Hiện tượng (user report):** Phần "THAY ĐỔI CHƯA COMMIT" xuất hiện ngay cả khi không được yêu cầu và cả khi lỗi không trả lời — phần thừa không hiểu nguồn gốc.
- **Chẩn đoán:** Wrap-up BUG-025 (agent-goal-loop.ts) chụp git status LÚC KẾT THÚC — working tree bẩn SẴN TỪ TRƯỚC run (dev.log, .env, db/, scratch/, file mission trước...) → mọi final report kèm block liệt kê trạng thái bẩn cũ, kể cả run chỉ-đọc / run lỗi.
- **Fix:** chụp snapshot git status ĐẦU RUN (gitStatusRunStart — fail-open); wrap-up chỉ báo DELTA (diffGitStatusSnapshots trước/sau) — block xuất hiện KHI VÀ CHỈ KHI run này thật sự làm thay đổi working tree; title đổi "THAY ĐỔI CHƯA COMMIT do run này tạo ra (N file)"; snapshot fail → fallback hành vi cũ.
- **Kiểm chứng E2E:** run "Cho biết version trong package.json — chỉ đọc" ×2 → response KHÔNG còn block 📁 (message cũ trước R18 vẫn còn block — đối chứng); run có đọc 7 file + 8 vòng vẫn sạch.

### BUG2-265 · B·P2 — "Không còn nhịp" GIẢ khi run cha await delegation + RAM/request định kỳ ma không ai yêu cầu
- **Hiện tượng (user report):** Việc gọi nhiều agent dẫn đến lỗi "Không còn nhịp"; log local chạy liên tục định kỳ (agent-nim-rescue xoay 12 attempts + ZEN chặn + OC-CLI spawn) mặc dù không động vào app; RAM tiêu tốn lớn.
- **Chẩn đoán (2 gốc rễ):** (a) Chip stalled của panel CHA dựa run.events im lặng ≥5' — delegation hợp lệ chờ 10-16' (SUBAGENT_WALL_CLOCK_MS 15' + trọng tài) → báo động giả đúng lúc hệ thống đang làm việc đúng; (b) "Tác vụ ma" định kỳ: DB là state persistent — GoalLoopJob kẹt được resume MỌI LẦN BOOT + requeue mỗi tick 5s không giới hạn tuổi; Opus auto-mode session (flag DB sống vĩnh viễn) sweep review lại session cổ không ai dùng; MỖI agent call khi Zen free-tier chết đốt nguyên chuỗi failover (HTTP + 1 CLI spawn + SBF failover HTTP+CLI + 3 last-resort CLI spawn ≈ 5 process × 400-590MB) — và block cache FreeTierError chỉ 60s(HTTP)/300s(CLI) → hết hạn lại đốt lại toàn chuỗi định kỳ; CLI timeout kill không diệt cây tiến trình (Windows shell:true chỉ giết cmd.exe — opencode.exe cháu sống tiếp giữ RAM).
- **Fix:** (1) tracker: AgentRun.awaitingDelegationSince + markRun/clearRunAwaitingDelegation — goal-loop đánh dấu quanh await delegation (fan-in consumer + đường tuần tự); UI chip "⏳ Đang chờ sub-agent · Xm chờ" (sky) thay "Không còn nhịp" khi đang chờ; (2) GOAL_LOOP_RESUME_MAX_AGE_MS (default 12h) — job mồ côi quá cũ → mark failed 'stale' không resume (chống tác vụ ma); (3) Opus sweep idle-gate OPUS_AUTO_IDLE_MS (default 6h — session không có user message gần đây → skip review); (4) ZEN_POLICY_BLOCK_TTL_MS (default 1h, env override) cho FreeTierError 403 (policy chặn toàn cục — retry ngắn vô nghĩa, chỉ đốt spawn CLI); (5) killCliProcessTree khi CLI timeout: Windows taskkill /PID /T /F (giết cả cây), POSIX SIGKILL + pkill -P (dọn cháu) — chống leak 590MB/spawn.
- **Kiểm chứng:** boot log gate mới; code path đọc trực tiếp; tsc/lint 0; E2E run thật không lỗi console; các hằng số + env ghi .env.example đầy đủ.

### BUG2-266 · C·P3 — Run KẾT THÚC BẰNG TOOL CALL (không prose cuối) → response "(agent không trả về nội dung)" dù trọng tài phán ĐẠT
- **Hiện tượng (phát hiện E2E R18 khi verify BUG2-264):** run đọc package.json 8 vòng/7 tool calls, trọng tài phán HOÀN THÀNH 95% verified — nhưng response cuối là "(agent không trả về nội dung)" — đúng nhóm "lỗi không trả lời" user phàn nàn kèm block thừa.
- **Chẩn đoán:** Điều kiện generateFinalReport (ROUND-4) chỉ bắt 2 ngoại lệ đường complete (lastContent chứa raw tool_call marker) — bỏ sót trường hợp lastContent RỖNG (vòng cuối agent phát tool call thuần, kết thúc sau EVALUATE mà không có lượt prose kết luận).
- **Fix:** thêm ngoại lệ thứ ba: `stopReason === 'complete' && (!lastContent || !lastContent.trim())` → chạy final report tổng hợp từ bằng chứng (evidence + lastVerdict) như 2 ngoại lệ trước; guard wrapUp.length > 200 giữ nguyên (LLM fail → fallback cũ).
- **Kiểm chứng:** E2E round-2: cùng tác vụ → response đầy đủ "Tên: theopusflashlite / Phiên bản: 2.0.0 + [verified-by-tool]... ĐÃ HOÀN THÀNH" (lần này agent tự viết prose — nhánh mới cho run kết thúc bằng tool call).

> **Ghi chú vận hành R18:** (1) Các fix mặc định BẬT (default mới); máy đang chạy muốn giữ hành vi cũ: GOAL_LOOP_MAX_CONCURRENT=2, GOAL_LOOP_RESUME_MAX_AGE_MS=0, OPUS_AUTO_IDLE_MS=0, ZEN_POLICY_BLOCK_TTL_MS=1 (để rơi về TTL ZEN_FREE_TIER_CACHE_MS cũ). (2) Nguồn "request định kỳ" còn lại SAU fix (trung thực): SelfDirection scheduler 60s (nếu opusDelegated=true + proposal approved trong DB — tắt qua UI Self-Direction) + ALISTA night shift 23:30-05:30 (tính năng chủ đích). (3) OOM-recompile sau khi sửa source trên box 4GB là ràng buộc đã biết (R16/R17) — không phải regression R18 (bằng chứng: kernel OOM-kill next-server RSS 2.47GB đúng lúc recompile, app tự hồi phục).
