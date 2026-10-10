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
