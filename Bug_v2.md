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
