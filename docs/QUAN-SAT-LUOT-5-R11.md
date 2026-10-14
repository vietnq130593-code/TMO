# BIÊN BẢN QUAN SÁT LƯỢT 5 (R11) — QUY TRÌNH THỰC THI · DATABASE · NÃO BỘ · HYPERNAS

- **Ngày quan sát:** 2026-10-14 (10:30 – 12:00+ UTC)
- **Người quan sát:** Z.ai Code (main session — giao thức GIAO_THUC_GIAM_SAT_AGENTS.md)
- **Yêu cầu user:** (1) Quan sát lượt 5 đến khi agent hoàn thành tác vụ — tìm vấn đề/sai sót trong quy trình thực thi, vận hành database, hệ thống não bộ, hyperNAS, toàn bộ kiến trúc kết nối; (2) ghi dữ liệu quan sát ra .md rồi fix ngay cái fix được; (3) thiết kế "quy trình Thầy truyền lại" cho agents; (4) điều tra "chọn model nào agents cũng báo Space bunny free".
- **Phương pháp:** đọc DB trực tiếp (Prisma — READ-ONLY), tail dev.log (PM2 out), ps/top bộ nhớ, truy vết mã nguồn (chat route → goal loop → llm.ts → OC-CLI), đối chiếu AgentRunRecord/ChatMessage/Todo/ObservationEvent/GoalLoopJob/Workspace.

---

## 1. TÓM TẮT EXECUTIVE

Hệ thống **vận hành ĐÚNG kiến trúc thiết kế** — mọi cơ chế (goal loop, trọng tài, debt cycle, episodic, Q-learn, observation ledger, orphan sweep, salvage, MemWatchdog) đều làm đúng cái chúng được LẬP TRÌNH để làm. **Vấn đề nằm ở chính thiết kế mặc định**: một câu hỏi đơn giản của user bị đưa nguyên vào đường ống tác vụ nặng (goal loop đa chu kỳ + trọng tài + nợ kỹ thuật + subagent + khai thác bài học), mỗi lần gọi LLM free spawn 1 process ~600MB không giới hạn đồng thời, khiến hệ thống crash bộ nhớ lặp lại (PM2 restart 8 lần/75 phút) và đốt 2.705.820 tokens trong buổi sáng cho ~8 câu chat, trong đó 3 câu là "Trả lời 1 từ: OK".

**Câu trả lời câu hỏi model:** Agents báo "Space bunny free" là **nói thật** — mọi cuộc gọi đều rơi về space-bunny-free qua chuỗi failover vì các model khác lần lượt chết (exo-free: HTTP 410 ModelDeprecated; các model free khác: bị Zen chặn free-tier cả HTTP lẫn CLI theo đợt). ChatMessage chỉ ghi `model` CẤU HÌNH (exo-free…) chứ không ghi model THỰC TẾ phục vụ → user không bao giờ thấy sự thật trên UI.

---

## 2. DÒNG SỰ KIỆN TRỰC TIẾP (timeline 2026-10-14 UTC)

| Giờ | Sự kiện | Bằng chứng |
|---|---|---|
| 10:52:06 | user: "Trả lời ngắn gọn: 1+1=?" → đáp "2" sau **36.3s** | ChatMessage sess 5_htl84d |
| 10:53:45–11:07:09 | 4 phiên test "Trả lời 1 từ: OK" — 23s / 43s / 47.5s / 10s mỗi lần | ChatMessage ×4 |
| 11:24:14 | user: "Cho tôi biết hiện tại bạn đang là model gì" | sess 2_ejzmer |
| 11:24:16 | run_1791977056776_1 (Omega) start — 7 vòng ReAct, 9 tool calls, todo 6 mục (kiểm chứng env, /config, opencode.jsonc, "đóng nợ cũ" path-escape…) | ObservationEvent run.start + Todo |
| 11:28:43 | Đáp: "Tôi đang chạy trên model space-bunny-free, mã định danh opencode/space-bunny-free…" — **4 phút 29 giây, 500.891 tokens** cho câu hỏi danh tính | AgentRunRecord completed, tokens=500891 |
| 11:28:43 | Sau run: verdict "đủ conf 0.90" + Q-entry + reward R=1.0 + surrogate/policy train skip (đúng: thiếu data) + **khai thác ồ ạt ~35 episode-bài học từ lịch sử** (gồm bài học rác từ các phiên test "Trả lời đúng một chữ: OK" conf 0.85!) | ObservationEvent learn.episode ×35 |
| 11:32:00 | user: "Từ workspace tiến hành xác định… hệ thống đang có bao nhiêu Brain và chức năng, vai trò" | sess 2_ejzmer |
| 11:32:01 | run_1791977522382_1 (Omega) start — chu kỳ 1 làm đúng phương pháp (quét workspace, jq/grep/BrainKey đối chiếu 3 nguồn, nghiệm thu 3 tiêu chí) | Todo run 1791977522382 |
| 11:35:03 | Omega **spawn SubAgent SENTINEL** "Chẩn đoán nguyên nhân gốc lỗi 'Access denied: path escapes workspace root' khi gọi file_read/grep" | SubAgentSlot 1/3 + run sub_1791977703792_2 |
| 11:35:11 | Omega **spawn SubAgent ALISTA** (nhiệm vụ kiểm định khác) | run sub_1791977711176_3 |
| ~11:35:5x | **MemWatchdog: MemAvailable toàn cục 364MB < 450MB — self-exit** (RSS next-server 917MB + 2 process opencode ~600MB mỗi cái + qdrant + opencode-server + cron-scheduler trên box 4GB) | dev.log line 5814-5815 |
| 11:36:00 | PM2 restart (#7→#8, tổng 8). Boot sweep: 3 run 'running' mồ côi → failed/crashed + salvage; OBS-ALERT token-burn run_1791977522382_1 **646.338 tokens status=failed**; Q-learn reward=-1; user nhận 3 tin "⚠️ Tác vụ bị gián đoạn… Bạn có thể gửi lại yêu cầu" | ObservationEvent + dev.log |
| 11:38:29 | **User gửi lại đúng câu hỏi Brain** (theo gợi ý của hệ thống) → run_1791977910683_1 (Omega) chạy tiếp, tool calls tmo_file_list, tmo_knowledge_graph…; exo-free vẫn 410 → failover SBF phục vụ | ChatMessage + dev.log |
| 11:38+ | Quan sát tiếp diễn đến khi agent hoàn thành — cập nhật mục 8 | (đang theo dõi) |

---

## 3. PHÁT HIỆN THEO TẦNG

### 3.1. QUY TRÌNH THỰC THI TÁC VỤ — nơi đau nhất

- **P1-1 (NGHIÊM TRỌNG — gốc rễ phàn nàn user): Mọi tin nhắn chat đều đi qua goal loop đầy đủ.** `/api/openclaw/chat` → `runGoalDrivenLoop` (hoặc durable enqueue) — không có phân loại yêu cầu. Câu "1+1=?" đi qua: archive todo → directive guard → PRE-ACT episodic (3 lessons applied) → system prompt đồ sộ (goal protocol 4 giai đoạn + OODA + ngôn ngữ + infra self-service + Q-hint + tool schemas…) → chu kỳ PLAN→EXECUTE→VERIFY→EVALUATE với trọng tài độc lập → Q-learn → khai thác episode → brain train attempt. Prompt protocol có dòng miễn truyện ("câu hỏi kiến thức thuần túy thì chỉ cần trả lời") nhưng **bộ máy quanh LLM vẫn chạy nguyên** — đó là chi phí thật (tokens + bộ nhớ + thời gian), không phải chi phí prompt.
- **P1-2: DEBT CYCLE cho tác vụ trivia.** "[GoalLoop] Omega DEBT CYCLE (đợt 1/100): complete=true nhưng trọng tài quyết định 'continue' — chu kỳ 2 xử lý 4 side issue(s)" — trọng tài thấy tool lỗi phát sinh (path-escape!) → ép agent chạy tiếp dù mục tiêu chính đã xong; trần 100 đợt. Nợ kỹ thuật từ lỗi infra (path-escape) bị tính là việc của agent → vòng lặp tự duy trì.
- **P1-3: SubAgent cascade cho câu hỏi khảo sát.** Câu hỏi Brain (đọc 1 file registry.ts là trả lời được) sinh ra 2 subagent chẩn đoán + kiểm định vì tool file_read/grep bị path-escape chặn (xem 3.5) — agent làm đúng纪 luật "thất bại → chẩn đoán", nhưng nguyên nhân là infra lỗi, và chi phí nhân bản.
- **P1-4: Token-burn 500K–646K cho 1 câu hỏi.** run "model gì" = 500.891 tokens / 4.5 phút; run "Brain" = 646.338 tokens rồi chết. Tổng buổi sáng 2.705.820 tokens — phần lớn input tokens lặp lại (system prompt đồ sộ gửi lại mỗi vòng, context phình, nén heuristic).
- **P1-5 (điểm sáng): Phương pháp luận bên trong run là TỐT.** Todo run Brain: "Quét workspace KHÔNG ĐOÁN tên file" → đối chiếu 3 nguồn (jq length=3, grep -c=3, BrainKey union=3) → nghiệm thu từng tiêu chí → trích dẫn bằng chứng. Đây đúng chuẩn kỷ luật — vấn đề không phải agent "làm sai" mà là **được đưa vào đường ọng quá nặng cho việc quá nhẹ**.

### 3.2. DATABASE — vận hành đúng, dữ liệu có nhiễm

- **ĐÚNG:** 105 bảng; WAL + busy_timeout + cache_size 64MB; observation ledger ghi đủ (obs.health 10 phút/lần, run.start/heart/end, verdict.add, token-burn alert, orphan-sweep alert); orphan sweep + salvage chạy đúng sau crash (3 run mồ côi → failed/crashed + metadata, không blind spot); tombstone hydrate 14 phiên; AgentRunRecord 1 chat = 1 row.
- **P2-1 (V-1 tái phát — dữ liệu bẩn):** Episode/Lesson miner chạy lúc 11:28:46–47 đẻ **~35 "bài học" từ lịch sử** kể cả các phiên test "Trả lời đúng một chữ: OK" (conf 0.85), "1+1=?" — bài học vô giá trị ("Khi dùng tool harness_warning trong task kiểu 'Trả lời đúng một chữ: O'"), ghi đúp 2 lần trong 300ms. Đây là dữ liệu bẩn tương tự V-1 (R8) — giờ ở tầng EPISODE (không phải LessonRecord), sẽ ô nhiễm lessons_search + Brain-B khi tích lũy đủ.
- **P2-2 (nhẹ):** 5 AgentSession test "OK" nằm trong production; `model.sync` "baseline lần đầu" lặp 5 lần (mỗi restart mất globalThis state → sync lại từ đầu, mỗi lần 1 lần spawn CLI + network).

### 3.3. HỆ THỐNG NÃO BỘ (BRAIN) — đúng thiết kế, đang "đói dữ liệu"

- Registry code định nghĩa **3 Brain** (surrogate — dự phó thành công; policy — chọn hành động; calibration — hiệu chuẩn), khớp kết luận 3 nguồn của Omega (jq/grep/BrainKey).
- `BrainModel` DB: **0 row** (chưa có brain nào được train persist); `BrainSearchRun` = 0, `BrainSearchCandidate` = 0.
- Train attempt sau run: surrogate skip "only 3 usable AgentRunRecord rows (need 60+)", policy skip "only 0 QEntry rows (need 30+)" — **đúng thiết kế ngủ an toàn** (H1/H2 không tự ghi), không crash, không false-done.
- ĐÁNH GIÁ: não bộ kết nối đúng kiến trúc nhưng **bị cắt nguồn dữ liệu** do container reset (DB lịch sử runs không có trong backup — DB user dài hạn chỉ có 56 runs cũ với phần lớn tokens null). Cần tích lũy lại từ 60+ runs chất lượng.

### 3.4. HYPERNAS — đúng thiết kế chờ

- Hạ tầng bảng + seed + fingerprint đầy đủ theo blueprint §4.2 (R8 đã audit); lượt này xác nhận tiếp: 0 search session, 0 candidate — **bất biến H1/H2 giữ vững** (không tự ghi khi chưa đủ điều kiện). Không có dấu hiệu kết nối sai.

### 3.5. WORKSPACE & PATH GUARD — chuỗi lỗi infra đang kích hoạt mọi cơn bão

- **P5-1 (GỐC RỄ): Workspace active = `E:\APP\TMO-clone`** (Windows path từ máy user, theo DB backup khôi phục). Trên Linux: `existsSync('E:\APP\TMO-clone')` **trả true** vì resolve thành thư mục literal rác `/home/z/tmo-app/E:\APP\TMO-clone/` (từng bị file_write ghi vào) → `ensureDefaultWorkspace` kết luận "đã sẵn sàng — bỏ qua bootstrap" → mọi tool file resolve theo root vô nghĩa này.
- **P5-2:** path TUYỆT ĐỐI trong workspace bị chặn oan (path.resolve(absRoot, absPath) = absPath ≠ dưới absRoot literal) → "Access denied: path escapes workspace root" — đúng như dossier ESCALATION-path-escape (2 lỗi 13/10 + tái hiện 14/10).
- **P5-3 (nặng nhất theo dossier):** file_write đường tương đối trả `success:true, bytesWritten` nhưng file KHÔNG tồn tại ở chỗ mong đợi (ghi vào root `E:\APP\TMO-clone` literal) — **receipt nói dối** → agent tin → lặp tool → spawn subagent chẩn đoán.
- **P5-4:** `/tmp/opencode` (quy ước scratch của agents) nằm ngoài allowlist → denied (dossier mục 0).

### 3.6. MODEL ROUTING & DANH TÍNH — giải thích "luôn Space bunny free"

- **P6-1:** Session user cấu hình `model: space-bunny-free, provider: zen` (mặc định theo policy 2026-11-30). Các lần thử model khác rơi chuỗi failover: `exo-free` → **HTTP 410 ModelDeprecated** (model đã bị Zen khai tử) → CLI exit 1 → **ZEN FAILOVER space-bunny-free** ✓. Các model free khác (ling/mimo/step/5-preview/longcat/big-pickle) bị chặn free-tier theo đợt (block cache 2h, policy Zen dao động — r74). Kết cục: **mọi câu trả lời thực sự do space-bunny-free phục vụ** → agent nói thật danh tính của nó.
- **P6-2 (khoảng trống trung thực):** `ChatMessage.model` + response JSON ghi `agentModel` CẤU HÌNH, không ghi `result.model` THỰC TẾ (llm.ts đã có `actualModel` từ event CLI nhưng bị vứt ở tầng trên). UI không có chỗ nào nói "bạn chọn X nhưng Y đang phục vụ".
- **P6-3:** 410 ModelDeprecated vẫn được retry mỗi call (block cache có TTL 2h thay vì permanent) → mỗi lần gọi exo-free tốn thêm 1–2 spawn CLI ~600MB + 5–10s.

### 3.7. BỘ NHỚ & ỔN ĐỊNH — crash loop

- **P7-1:** Mỗi call OC-CLI spawn `opencode run` = process ~600MB (next-server 667MB + 2 opencode đồng thời = ~1.9GB + qdrant 63MB + opencode-server + cron-scheduler + PM2 trên box 4GB, buff/cache 1.1GB) → MemAvailable tụt < 450MB → MemWatchdog global-guard self-exit (đúng thiết kế chống kernel OOM) → PM2 restart → mất run đang sống.
- **P7-2:** App crash giữa chừng để lại **opencode run mồ côi** (PPID=1 hoặc treo) — không ai dọn; cộng dồn vào lần crash kế.
- **P7-3:** PM2 restart 8 lần/75 phút (11:30, 11:35…), mỗi lần giết run + user nhận "Tác vụ bị gián đoạn".
- **P7-4 (điểm sáng):** MemWatchdog + HttpWatchdog + orphan sweep + salvage + durable-resume thiết kế tốt và hoạt động đúng — vấn đề là **nguồn áp lực** (P1 + P7-1) chứ không phải cơ chế phòng thủ.

---

## 4. KIẾN TRÚC KẾT NỐI — kết luận tổng thể

| Thành phần | Kết nối đúng kiến trúc? | Ghi chú |
|---|---|---|
| Chat → goal loop → llm.ts → Zen/NIM/OC-CLI | ✅ đúng luồng | nhưng KHÔNG có nhánh fast-path (P1-1) |
| Trọng tài ↔ verdict ↔ debt cycle ↔ re-dispatch | ✅ đúng | debt cycle bị lạm dụng cho infra-error (P1-2) |
| Episodic ↔ lessons_search ↔ PRE-ACT | ✅ đúng | dữ liệu đầu vào nhiễm test (P2-1) |
| Brain 3 não ↔ train gate ↔ Q-learn | ✅ đúng | đói dữ liệu (3.3) |
| HyperNAS | ✅ đúng (chờ H1/H2) | 3.4 |
| SQLite + Neo4j + Qdrant 3 kho | ✅ đúng | backup DB user khôi phục nguyên vẹn 61 sessions/358 msgs |
| Workspace → path guard → file tools | ❌ **SAI** root active (P5-1) | chuỗi bão path-escape + receipt nói dối |
| OC-CLI spawn ↔ bộ nhớ hệ thống | ❌ **THIẾU** kiểm soát đồng thời | crash loop (P7-1) |
| Model chọn ↔ model phục vụ ↔ hiển thị | ❌ **KHÔNG trung thực** | P6-2 |

---

## 5. GIẢI ĐÁP CÂU HỎI USER "CHỌN MODEL NÀO CŨNG BÁO SPACE BUNNY FREE"

1. Model free duy nhất ổn định trên cả 2 transport là space-bunny-free; mọi model khác chết theo đợt (exo-free chết vĩnh viễn — 410 deprecated).
2. Chuỗi failover trong llm.ts luôn đổ về ZEN FAILOVER = space-bunny-free (env `ZEN_FAILOVER_MODEL` mặc định).
3. Agent trả lời theo danh tính THẬT của model đang phục vụ (opencode CLI truyền model id cho model) → nói "space-bunny-free" là CHÍNH XÁC, không phải ảo giác.
4. UI/DB không cho thấy model phục vụ thật → user tưởng mình đang dùng model đã chọn. **Fix: ghi + hiển thị servedModel, đánh dấu model chết (410 permanent), cho chọn model sống thật.**

---

## 6. GIÁO THỨC THẦY TRUYỀN LẠI (quy trình thực thi mới cho agents)

Xem đầy đủ: **docs/GIAO-THUC-THAY-TRUYEN-LAI.md**. Tinh thần: *Nghe → Phân loại → Khảo sát → Kế hoạch tối thiểu → Thực thi từng bước kèm kiểm chứng → Báo cáo trung thực → Dọn dẹp*. Cốt lõi thay đổi: **bậc thầy không dùng cần cẩu để bóc một trái chuối** — câu hỏi đơn giản trả lời ngay (1 call), tác vụ mới mở toàn bộ đường ống; nợ infra không giao cho agent trả trong phiên chat; mỗi hành động phải có bằng chứng độc lập (không tin receipt chưa verify); token là tiền — ngân sách mặc định cho mọi run.

---

## 7. DANH SÁCH FIX (thực hiện ngay lượt này)

| Mã | Vấn đề | Fix | Trạng thái |
|---|---|---|---|
| F1 | Workspace active `E:\APP\TMO-clone` (P5-1) | Validate cross-platform rootPath (isRootPathSaneForPlatform) + auto-heal về app dir lúc runtime + boot; .env sandbox chuyển POSIX; CÙNG agent Omega tự viết sanitizeEnvPath + resolve-cwd (2 nguồn bổ trợ, đã hòa giải) | ✅ verify live (log auto-heal + tools giải phóng) |
| F2 | Path guard chặn oan + /tmp/opencode (P5-2, P5-4) | allowlist scratch root /tmp/opencode + auto-mkdir + error message liệt kê root hợp lệ | ✅ (tsc+lint pass) |
| F3 | Receipt success-giả (P5-3) | file_write trả absPath + verified (existsSync sau ghi) + hint cảnh báo khi verify fail | ✅ |
| F4 | Chat không fast-path (P1-1) | TRIAGE tầng API (src/lib/execution/triage.ts): heuristic 0-chi- phí + classifier LLM cho ca mơ hồ + marker NEEDS_FULL_PIPELINE tự thoát; env ENABLE_CHAT_TRIAGE=0 rollback | ✅ verify E2E: cùng câu hỏi model 4m29s/500K tokens → 13-18s/1 call/0 tool |
| F5 | Model không trung thực (P6-2) | servedModel (model phục vụ thật) qua GoalLoopResult + ChatMessage.metadata + response JSON — cả 2 đường inline/durable + fast-path | ✅ verify E2E (metadata persist đầy đủ sau khi thêm retry) |
| F6 | 410 vẫn retry (P6-3) | ModelDeprecated 410 → block cache PERMANENT 365 ngày cả 2 transport + seed exo-free (đã quan sát 410 ×2 hôm nay) | ✅ |
| F7 | OC-CLI 600MB/process không giới hạn (P7-1) | Semaphore giới hạn spawn đồng thời (mặc định 1, env OC_CLI_MAX_CONCURRENT; globalThis-guard chống đa instance) | ✅ (tsc+lint pass; serialize verified qua log 🚦) |
| F8 | opencode mồ côi sau crash (P7-2) | Đã có sẵn sweepOcCliOrphans (boot +10s + 5 phút/lần, SIGKILL PPID=1) — xác nhận đủ, KHÔNG cần thêm | ✅ (đã tồn tại — verify) |
| F9 | Episode bài học rác từ test (P2-1) | (a) dọn: 1 SQLite + 2 Neo4j lesson test-pattern đã xóa (verify 21 lesson còn lại sạch); (b) gate: goal trivia (<40 chars / ^trả lời…) KHÔNG đúc bài học — episode vẫn ghi | ✅ |
| F10 | DEBT CYCLE trần 100 cho infra-error (P1-2) | Trần mặc định 100 → 10 (env GOAL_LOOP_MAX_DEBT_CYCLES) | ✅ |
| F11 (mới) | SQLite "Socket timeout" contention lúc response (phát hiện E2E) | saveChatMessages bọc withSqliteRetry + fast-path persist retry +2s/+8s/+20s — verify message lưu OK | ✅ verify E2E |

---

## 8. QUAN SÁT RUN HOÀN THÀNH (câu hỏi Brain của user — 3 run, 2 crash)

### 8.1. Diễn biến 3 run của CÙNG một câu hỏi "hệ thống có bao nhiêu Brain"

| Run | Bắt đầu | Kết cục | Tokens | Ghi chú |
|---|---|---|---|---|
| run_1791977522382_1 | 11:32:01 | ⚠️ CHẾT vì crash #7/#8 (MemWatchdog MemAvailable 364MB) — user nhận 3 tin "Tác vụ bị gián đoạn" | 646.338 | spawn SENTINEL + ALISTA chẩn đoán path-escape |
| sub_1791977703792_2 (SENTINEL) | 11:35:03 | ⚠️ mồ côi → failed/crashed | — | chẩn đoán lỗi path-escape |
| sub_1791977711176_3 (ALISTA) | 11:35:11 | ⚠️ mồ côi → failed/crashed | — | |
| run_1791977910683_1 (user gửi lại 11:38:29) | 11:38:30 | ⚠️ CHẾT vì crash #9 (kill âm thầm ~11:56:42 — RSS vượt ngưỡng reaper khi run + SelfDirection + recompile chồng nhau) — 751.033 tokens, complete=true nhưng KHÔNG kịp lưu tin nhắn cuối | 751.033 | chu kỳ 2 làm đúng phương pháp (đối chiếu 3 nguồn jq/grep/BrainKey = 3 Brain) |

**Tổng thiệt hại 1 câu hỏi: ~1.4M tokens, 9 lần restart PM2, 3 tin gián đoạn, user phải gửi lại 2 lần.** Đây là tất cả bằng chứng cần có cho F4 (triage) + F7 (semaphore) + F10 (debt cap).

### 8.2. Phát hiện VÀNG — agent TỰ SỬA hạ tầng giữa chừng (INFRA SELF-SERVICE sống)

Trong run cuối, Omega VỪA trả lời câu hỏi VỪA triển khai fix hạ tầng theo đúng protocol [H] — tạo `src/lib/workspace/sanitize-env-path.ts` (11:46), `resolve-cwd.ts`, `docs/SPAWN-ENOENT-CWD-TRACE.md`, sửa ensure-default-workspace + workspace-context — giải quyết CÙNG con bug workspace root mà người quan sát đang fix! Nhưng cũng để lộ đúng vấn đề Giáo thức Thầy cảnh báo:
- **Agent edit dở:** call `resolveCwd()` mà quên import → shell tool chết "resolveCwd is not defined" ×16 → tự cắn đuôi (người quan sát đã bổ sung import tức thời để mở khóa run theo nguyên tắc fix-ngay).
- **Test viết theo vitest (repo dùng bun:test)** — người quan sát đã chuyển + sửa 1 test sai chính nó (path.join tự normalize `..`) + bổ sung reason-code DRIVE_LETTER cho mid-path drive letter (12/12 pass).
- **Meta-bài học:** việc đúng (tự sửa infra) vào lúc sai (giữa phiên chat trả lời user) với chi phí khổng lồ — đúng cảnh báo Kỷ luật #4 + #6 của Giáo thức Thầy.

### 8.3. Phát hiện bổ sung trong quá trình fix

- **P-NEW-1: SQLite "Socket timeout" contention tập trung lúc response** — mọi write trong app process (saveChatMessages, addToWorkingMemory, ledger.writeOne, TokenTracker upsert) cùng ùn đúng lúc response với transaction timeout 5000ms, trong khi process ngoài ghi cùng lúc chỉ 2ms. Đã giảm thiểa bằng withSqliteRetry + retry kéo dài; gốc rễ sâu hơn (pool Prisma trong next dev) ghi nhận là nợ kỹ thuật.
- **P-NEW-2: SelfDirection chạy escalation 6 bước song song** (ALISTA→SHOCWAVE→RAMPAGE×2→SENTINEL→Omega — "fix vòng lặp prose-only nudge 80/172 lần") cùng lúc với run chat của user — nguồn áp lực bộ nhớ/tokens song song ít được nhìn thấy; scheduler ALISTA (23:30→05:30) cũng bật tại boot. F7 semaphore giờ serialize toàn bộ OC-CLI spawn — bóp huyết áp hệ thống về mức an toàn.
- **P-NEW-3: 2 instance cron-scheduler** chạy song song (bun index.ts ×2) — cần kiểm tra service-manager duplicate (ghi nhận, chưa fix — ngoài phạm vi).

### 8.4. Verify E2E sau fix (12:15-12:30 UTC)

| Kiểm tra | Kết quả |
|---|---|
| Boot workspace auto-heal | ✅ log: "R11 auto-heal: active E:\APP\TMO-clone vô hiệu → deactivate + kích hoạt /home/z/tmo-app" — tools file giải phóng |
| Health | ✅ 200 trong 90-160ms |
| Fast-path E2E ("Bạn đang là model gì?") | ✅ 13-18s / 1 call / 0 tool / 0 goal-loop (trước: 4m29s / 500.891 tokens / 9 tool) — fastPath:true + servedModel trong response VÀ metadata persist (sau khi thêm retry F11) |
| Triage phân loại | ✅ câu Brain → task; "1+1" → question (classifier LLM); "ok" → question (0 chi phí); "sửa file" → task |
| Test resolve-cwd của agent | ✅ 12/12 pass (sau fix import + reason code + test sai) |
| Gate tsc / lint | ✅ 0 lỗi / 0 warning |
| Lesson sạch | ✅ 1 SQLite + 2 Neo4j lesson test-pattern đã xóa (còn 21 lesson sạch) |
| PM2 ổn định sau restart cuối | ✅ không restart thêm (trước đó 10 lần/2.5h) |

### 8.5. Câu trả lời câu hỏi user (thay agent — tổng hợp từ bằng chứng run + registry)

Hệ thống TMO có **3 Brain** (registry `src/lib/brain/registry.ts`, xác minh 3 nguồn: jq length=3, grep -c key=3, BrainKey union=3):
1. **Brain-A · Calibration V3** (`calibration_v3`) — chuẩn hóa độ tin cậy kiến thức KB; MLP 2 lớp thay logistic V2 khi thắng đối chứng 5-fold CV (Brier); phase BRAIN-P2.
2. **Brain-B · Surrogate** (`surrogate`) — dự phó thành công run (đọc đặc trưng từ AgentRunRecord — features `agentRuns`); thức tỉnh khi đủ 60+ runs chất lượng; hiện đang ngủ an toàn (chỉ 3 usable rows sau restore).
3. **Brain-C · Policy** (`policy`) — chính sách chọn hành động/model (task-features + Q-table); thức tỉnh khi đủ 30+ QEntry; hiện 1 entry đầu tiên vừa sinh lúc 11:28.

Cả 3 chưa có trọng số train persist (BrainModel 0 row) — ĐÚNG thiết kế chờ dữ liệu (bất biến H1/H2 giữ vững: 0 BrainSearchRun, 0 Candidate).

---

## 9. META QUAN SÁT (về chính phiên quan sát)

- Lần đầu quan sát BẮT ĐƯỢC user retry theo gợi ý của hệ thống ("Bạn có thể gửi lại yêu cầu") — tín hiệu UX hoạt động nhưng cũng là vòng lặp tốn kém: mỗi retry đốt lại toàn bộ chi phí đường ống nặng.
- Nhận định lớn nhất lượt này: **các cơ chế phòng thủ hoạt động hoàn hảo, nhưng đang phòng thủ chính cái đường ống gây ra sự cố**. Fix phải nằm ở tầng phân loại yêu cầu + kỷ luật tài nguyên, không phải thêm lớp phòng thủ.
- Kỷ luật quan sát viên: mọi số liệu lượt này lấy trực tiếp từ DB/log bằng truy vấn, không ước lượng; truy vấn bằng Prisma READ-ONLY (bài học R8 về db.write seq).
- Lượt này có tình huống mới: người quan sát phải CAN THIỆP TƯỚC THỜI (bổ sung import resolveCwd mà agent bỏ sót) vì tool chết đang chặn câu trả lời cho user — ranh giới giữa "quan sát không can thiệp" và "fix ngay được thì fix ngay" (user cho phép) đã được xử lý minh bạch: mọi can thiệp ghi trong mục 8.2.
- Hai "người sửa" song song (agent Omega tự sửa hạ tầng + người quan sát sửa hệ thống) cùng hội tụ về cùng con bug workspace root từ 2 hướng khác nhau — bằng chứng kiến trúc protocol [H] INFRA SELF-SERVICE hoạt động, nhưng cũng bằng chứng cho thấy cần triage ở tầng HARNESS (F4) để việc hạ tầng không cướp phiên chat của user.
