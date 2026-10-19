# BLUEPRINT: HIỆU QUẢ QUY TRÌNH THỰC THI AGENT (EXECUTION-EFFICIENCY)

**Phiên bản:** 0.2 (chẩn đoán + thiết kế — CHƯA triển khai; r43 review bởi kỹ sư AI/kiến trúc sư: đối chiếu 12/12 điểm gãy với code từng dòng + hiệu đính 16 điểm — xem §9. Cấu trúc P/S/W giữ nguyên.)
**Ngày:** 2026-10-19
**Nguồn bằng chứng:** Run thật `run_1792386145100_1` (job `cmvesfiqk000nsnnhiuah7bfe`, goal *"điều phối team Research nghiên cứu quy trình thực thi tác vụ"*, 05:02–05:59 UTC 19/10) + quan sát giao thức R41-OBSV1 + OBSV-RESET3-RUN1.
**Ký hiệu:** P1–P8 = 8 vấn đề · S1–S8 = 8 giải pháp (map 1-1) · W1–W3 = 3 wave triển khai.

---

## 0. TÓM TẮT ĐIỀU HÀNH

**Directive user (nguyên tắc đứng của blueprint này):**

> Hệ thống thiết kế cho các agent có thể làm việc trong thời gian dài hạn và xử lý các khối công việc lớn. Việc agent xử lý tốn thời gian, tốn token hơn mức cần thiết cho thấy vấn đề nằm trong **quy trình thực thi, xử lý tác vụ** của agent. Việc giới hạn token KHÔNG giải quyết được vấn đề — trái lại dễ thêm vấn đề mới là agent không đủ token làm việc.

**Chẩn đoán 1 dòng:** Trong run bằng chứng, công việc nghiên cứu **ĐÃ HOÀN THÀNH** (ALISTA trả báo cáo đầy đủ, trọng tài chấm ĐẠT 92%) nhưng **GIAO HÀNG THẤT BẠI** — mọi đường truy hồi bằng chứng đều gãy hoặc cắt xén, run chìm 4/6 chu kỳ vào việc hồi phục bằng chứng + evaluator chết, kết thúc `no_progress` với final report **không chứa bất kỳ kết quả nghiên cứu nào**.

**Định lượng lãng phí (2.432.847 tokens / 3.043s / 6 chu kỳ):**

| Thành phần | Token | Ghi chú |
|---|---|---|
| Omega parent (tự thân — gồm cả evaluator + consult + final-report attempts) | 808.095 = 2.432.847 − 1.624.752 | 22 vòng, 36 tool calls thực thi (trace ghi 37 tool events — web_fetch fail có event nhưng không tính executed) — trong đó ~4/6 chu kỳ dành cho HỒI PHỤC bằng chứng thay vì việc chính |
| Sub-agent ALISTA | 1.624.752 (**67%**) theo `result.goalLoop.subagentTokens`; run_end trace tự ghi 1.634.491 (gồm thêm ~9,7K token trọng tài — OBS-ALERT "1.634,5K" lấy từ đây) | 48 vòng ReAct, 47 tools, **KHÔNG có nén context giữa chừng** — tích luỹ bậc 2 |
| (trong đó) Auto-escalate consult | ~10.132 — ĐÃ nằm trong 808.095, không cộng thêm | Do evaluator trả verdict rỗng |
| **Deliverable thực tế giữ được** | **~0** | 6 entity có trong DB nhưng vô hình với search; báo cáo đầy đủ không tồn tại trọn vẹn ở bất kỳ đâu |

**8 vấn đề rút ra (chi tiết §2):** P1 KB write/read bị ngắt đoạn · P2 bằng chứng bị cắt ở 6 tầng · P3 evaluator/final-report chết theo model yếu · P4 sub-agent loop không nén context + quy trình tool rời rạc · P5 environment friction lặp lại · P6 OOM hạ tầng · P7 todo evidence gate gãy theo đường bằng chứng · P8 quan sát nền còn treo.

**Nguyên tắc giải pháp (§3–4):** process-first — sửa **đường ống bằng chứng** và **đường ống thực thi**; token cap chỉ giữ vai trò safety-net tối hậu, không phải công cụ hiệu quả.

---

## 1. BỐI CẢNH + BẰNG CHỨNG RUN

### 1.1 Dòng thời gian run `run_1792386145100_1`

| Thời điểm | Sự kiện |
|---|---|
| 05:02 | Job tạo, Omega run start |
| 05:04 | Omega lập todo 5 mục (Nghiệm thu 1-4: điều phối ALISTA → chốt danh sách → Code Team sửa → kiểm định) |
| 05:05 | Dispatch ALISTA lần 1 (`sub_1792386324439_2`) — 92s sau bị **OOM crash** giết giữa chừng (11 tools, whiteout) |
| 05:07–05:09 | Orphan-sweep ×2 (OOM crash-loop, attempts 0→2/2) — operator đóng chrome giải phóng 500MB |
| 05:13 | RESUME checkpoint chu kỳ 2 → Omega đọc trace sub-run chết, tự dựng brief "tiếp nối phần còn thiếu" → re-dispatch ALISTA lần 2 (`sub_1792386783023_1`) |
| 05:13–05:20 | ALISTA-2 chạy 48 vòng / 47 tools / 1,63M tokens (run_end tự ghi 1.634.491 gồm token trọng tài; job result ghi 1.624.752): 29 shell (python3 sqlite3) + 9 todo_write + 6 knowledge_write + todo_read ×2 + file_read — kết luận `concluded`, trọng tài ĐẠT 92% |
| 05:20–05:27 | Chu kỳ 2-3: Omega nhận kết quả nhưng **báo cáo bị cắt** khi truy hồi từ trace (đúng bảng 6 vấn đề, mất ở dòng 2) → grep/tail trace nhiều lần → evaluator "CHƯA ĐẠT tin cậy 10%" → auto-escalate |
| 05:27 | OBS-ALERT: ALISTA đốt 1.634,5K tokens (ngưỡng 500K D1.4) |
| 05:13–05:20 | (song song trong lúc ALISTA-2 chạy) 6 `knowledge_write` của ALISTA ghi LocalEntity — **thành công**, có tên + mô tả đầy đủ trong DB (description 195–1.054 ký tự/entity) |
| ~05:40 | Chu kỳ 4: Omega `knowledge_search` ×3 + `knowledge_graph` → **KHÔNG thấy 6 entity** → kết luận sai "chúng nằm trong research_kb riêng của ALISTA" → todo `cmveshoai000wsnnhnvj9bpb0` kẹt |
| 05:57 | OBS-ALERT ×2: glm-5.3-flash fail 4 lần (circuit breaker mở) + zen free-tier fail 3 → chu kỳ 4-6 evaluator "(LLM lỗi)", 0-5 tools/chu kỳ |
| 05:58 | Stall brake CI-1 (3 chu kỳ không tiến triển) → job COMPLETED `no_progress` 6/12 chu kỳ; final report LLM fail 3× (empty content) → **BUG-024 fallback không-LLM** — in đúng thought cuối + dòng generic "evaluator lỗi" |
| 05:59 | Todo kẹt đóng `failed`; 5 todo Nghiệm thu 2/3/4 `pending`+archived; episode FAILURE ghi bài học |

### 1.2 Báo cáo cuối của Omega (user trích) — giải mã

> *"Todo kẹt cmveshoai000wsnn cần đóng bằng bằng chứng — nhưng knowledge_search KHÔNG thấy 6 entities của ALISTA (chúng nằm trong research_kb riêng của ALISTA, không phải KB chung của tôi). Nguồn chắc chắn nhất là trace sub-run sub_1792386783023_1.jsonl: 6 lệnh knowledge_write của ALISTA đều có argsSummary chứa tên + mô tả entity. ĐỊNH VỊ: chu kỳ này (a) truy hồi đủ 6 vấn đề từ trace để chốt danh sách và đóng todo kẹt, (b) điều phối Code Team sửa trên clone. DỰ ĐOÁN: python3 parse JSONL sẽ in ra 6 knowledge_write events + run_end; nếu thiếu mới fallback db_query."*

Đây là **thought cuối cùng** của Omega trước khi run chết — một kế hoạch hồi phục bằng chứng hoàn chỉnh và thông minh. Điều tra của blueprint này xác minh từng mệnh đề:

| Mệnh đề của Omega | Kết quả điều tra | Bằng chứng |
|---|---|---|
| "knowledge_search KHÔNG thấy 6 entities" | ✅ ĐÚNG — tái hiện được | Query tương tự trả 10-12 entity cũ từ Neo4j, 0/6 entity của ALISTA |
| "chúng nằm trong research_kb riêng của ALISTA" | ❌ SAI — entities nằm đúng KB chung (LocalEntity) nhưng **vô hình** với search | DB: 6 LocalEntity `entityName="TMO Execution Process Research - …"` đầy đủ; ResearchKBEntry = 0 bản ghi |
| "nguồn chắc chắn nhất là trace sub-run" | ⚠️ NỬA ĐÚNG — trace CÓ 6 events nhưng argsSummary chỉ 150 ký tự (đo thật: cả 6 đều đúng 150 — tầng builder cắt trước khi tracker truncate 200 ở :1019) + thought cắt 2400 ký tự | Trace: 6 events `knowledge_write` argsSummary đứt giữa chừng |
| DỰ ĐOÁN "python3 parse JSONL sẽ in ra 6 knowledge_write events" | ✅ ĐÚNG về số lượng, nhưng argsSummary **không chứa đủ mô tả** để chốt danh sách | Parse thật: 6 events, mỗi argsSummary đúng 150 ký tự (đều nhau — builder cố định, r43 đo lại) |

**Điểm mù hệ thống:** Omega không hề biết rằng mô tả ĐẦY ĐỦ của 6 entity đang nằm trong bảng `LocalEntity` — chỉ cách nó đúng 1 câu `db_query`/`SELECT` — vì (a) tool kết quả `knowledge_write` của ALISTA trả về tin "Đã ghi entity" mà không nói **ghi vào đâu, tìm lại thế nào**, (b) `knowledge_search` — đường tra cứu chính thức — không đọc bảng đó.

---

## 2. TÁM VẤN ĐỀ (P1–P8) — hiện tượng → bằng chứng → gốc rễ

### P1. KB write/read bị ngắt đoạn — `knowledge_write` ghi vào nơi mà `knowledge_search` không bao giờ đọc

**Hiện tượng:** ALISTA `knowledge_write` ×6 thành công (tool trả `success:true`, kèm id + tên entity) → Omega `knowledge_search` ×3 + `knowledge_graph` (Cypher `STARTS WITH 'TMO Execution Process Research'`) → 0 kết quả relevant.

**Bằng chứng (code, HEAD 067c56f):**
- Đường GHI: `knowledge_write` → `agentWriteEntity` (src/lib/knowledge-bridge.ts:353-373) → `db.localEntity.create({ …, source:'agent', synced:false })` — comment gốc: *"Write to SQLite buffer (LocalEntity) — will be synced to Neo4j later"*.
- Đường SYNC: `/api/sync-neo4j` (src/app/api/sync-neo4j/route.ts:221) chỉ sync `where: { documentId: docId, synced: false }` — **đồng bộ theo tài liệu (document-scoped)**. Entity agent ghi có `documentId: null` → **KHÔNG BAO GIỜ được sync lên Neo4j**.
- Đường ĐỌC: `knowledge_search` → `agentKnowledgeSearch` → `searchUserKB` (kb-routing/kb-access.ts) → 4 nguồn song song: chunks (Qdrant) + entities (**Neo4j** qua `searchEntitiesForUser` :633) + AgentMemory + communities. **Không nguồn nào đọc `LocalEntity`.**
- Tái hiện trực tiếp (script test 19/10): query tương đương → 12 kết quả entity cũ từ graph D0 (TMO_EXEC_TOKEN, execFile, Brain, fixbug.md…), 0/6 entity ALISTA; query semantic sát nội dung entity ("ToolMetric analysis failure rate shell sqlite3") → 10 kết quả, vẫn 0/6.
- Cộng hưởng: collection Qdrant trống sau reset #3 (868 chunk R38 mất theo sandbox) → layer chunks cũng trả 0.

**Gốc rễ:** Kiến trúc "buffer chờ sync" (`synced:false`) được thiết kế cho **entity trích xuất từ tài liệu** (có documentId, batch-sync theo doc). Tool `knowledge_write` của agent tái dùng bảng đó nhưng **rơi ngoài mọi đường sync lẫn mọi đường search**. Kết quả: một hố đen ghi-đọc — bao gồm cả `harvestDelegationLessonToKB` (subagent-delegate.ts:2102) — chính cơ chế "thu hoạch bài học delegation về KB" của hệ thống — cũng ghi `DelegationLesson` vào hố đen này (chỉ khi delegation có lỗi; run này ALISTA 0 tool-failures nên không fire — may mắn thay).

**Hệ quả quy trình:** Agent viết tri thức xong không tìm lại được → cha phải truy hồi từ nguồn thô (trace) → mất chu kỳ. Đây là nguyên nhân TRỰC TIẾP của todo kẹt trong báo cáo Omega.

---

### P2. Bằng chứng sub-agent không tồn tại trọn vẹn ở BẤT KỲ ĐÂU — 6 tầng cắt xén

**Hiện tượng:** Omega phải `shell tail/grep` file trace 52KB để lấy báo cáo ALISTA — và bản lấy được **bị cắt đúng giữa bảng 6 vấn đề ở dòng 2** ("…retry logic cho c…"), không đủ chốt danh sách.

**Bằng chứng — "thang cắt tầng" (mỗi tầng một cap):**

| # | Tầng lưu trữ | Vị trí code | Cap | Nội dung giữ được |
|---|---|---|---|---|
| 1 | Thought sub-agent trong trace JSONL | `agent-run-tracker.ts:182` `THOUGHT_MAX_CHARS = 2400` | **2.400 ký tự** | Báo cáo "## BÁO CÁO NGHIÊN CỨU…" đứt giữa bảng vấn đề dòng 2/6 (đo được 2.401 ký tự trong trace thật = 2.400 + dấu "…" mà truncateText nối thêm — r43) |
| 2 | Thought kết quả gửi parent | `agent-goal-loop.ts:1400` `dlClip(r.report, 220)` | **220 ký tự** | 1 dòng teaser |
| 3 | Tool result delegate (LLM cha nhận) | `subagent-delegate.ts:146` `REPORT_MAX_CHARS = 9.000` (env `SUBAGENT_REPORT_MAX_CHARS`) | 9.000 ký tự | Đầy đủ NHẤT — nhưng bị **nén context giữa chừng** (4 lần nén × 22–27K ký tự) tiêu hoá thành digest sau 1-2 chu kỳ |
| 4 | Digest thu hoạch KB | `subagent-delegate.ts:2094` `digestDelegationReport` | **700 ký tự** | Ưu tiên mục "Bài học" nếu có, không thì đầu báo cáo |
| 5 | `run_end` trong trace | tracker (summary) | ~87 ký tự thực tế | 1 dòng thống kê |
| 6 | `argsSummary` tool event trong trace | `agent-run-tracker.ts:1019` (push truncate 200; builder đường sub-agent cắt ~150 trước đó) | **150 ký tự** (r43 đo: 6/6 = 150) | args knowledge_write đứt giữa chừng — không đủ chứa mô tả entity (195–1.054 ký tự) |

Ngoại lệ duy nhất lưu ĐẦY ĐỦ: `description` của LocalEntity (P1) — không cap — nhưng vô hình với search (P1). **Tức là: dữ liệu tồn tại, chỉ là không đường nào đến được nó nguyên vẹn.**

**Gốc rễ:** Các cap ra đời vì lý do chính đáng riêng lẻ (chống phình trace, chống phình context cha, chống phình KB) — nhưng không tầng nào được thiết kế với bất biến **"báo cáo cuối của sub-agent phải tồn tại nguyên vẹn ở ít nhất 1 nơi có địa chỉ truy hồi 1 bước"**. `TaskContextArchive` (Kho Context) — cơ chế lưu digest nén context — hoàn toàn có thể giữ nguyên vẹn báo cáo này nhưng chưa được dùng cho delegation.

**Hệ quả quy trình:** Mỗi lần cần lại bằng chứng cũ (đánh giá chu kỳ, đóng todo, viết final report) → phải đào trace thủ công → trace thì bị cắt → kết luận dựa trên dữ liệu mất cụt → evaluator chấm CHƯA ĐẠT → lặp lại. Omega đã tạo thêm 2 todo "hồi phục từ trace" (nợ kỹ thuật tự phát sinh) — việc thuần meta tiêu chu kỳ.

---

### P3. Evaluator + final-report phụ thuộc một model yếu — chết là mất verdict, mất luôn báo cáo

**Hiện tượng (2 biến thể, đều bắt sống):**
1. **Reasoning starvation (R41-OBSV1, job cmve7ne2u):** evaluator glm-5.3-flash chết "reasoning tiêu hết max_tokens" ×2 chu kỳ liên tiếp — observation ghi **max_tokens=4000 kể cả sau khi nhân đôi vẫn cạn**. Giải mã (r43): con số 4000 là budget SAU nhân đôi — llm.ts R25 (:2931/:2994) tự retry cùng model 1 lần với budget ×2 khi reasoning hết (2.000 × 2 = 4.000), lỗi in kèm "(kể cả sau khi nhân đôi budget)". Tức lớp ×2 nội bộ ĐÃ tồn tại từ trước mà vẫn cạn → chứng minh ×2 không đủ, cần model-aware budget + ladder (S3). Model reasoning đốt budget cho suy luận trước, không còn chỗ trả JSON verdict → verdict null → rơi nhánh heuristic / auto-escalate.
2. **Circuit breaker (run bằng chứng này):** glm-5.3-flash fail 4 lần → breaker mở 600s → chu kỳ 4-6 evaluator "(evaluator LLM lỗi — kiểm tra lại toàn bộ kết quả)" → 2-3 chu kỳ gần như trắng (0-5 tools), confidence đứng yên 10%→50%→30%→30%; **final report LLM fail 3× (empty content)** → BUG-024 rơi đường fallback không-LLM.

**Bằng chứng (code):**
- Evaluator: `agent-goal-loop.ts:2126-2137` — `maxTokens: 2000`, temperature 0.2, **single-attempt** ở tầng caller — không retry model khác, không budget riêng cho reasoning model. (r43: llm.ts có 1 lớp retry ×2 nội bộ cho reasoning-starvation — R25 :2931 — quan sát cho thấy cả 4.000 vẫn cạn.)
- Auto-escalate: `consultOmega` nemotron-550b, `CONSULT_MAX_TOKENS = 1100` (omega-orchestrator.ts:64) — mỗi lần escalate ~10K tokens tổng (observation: 10.132) — đắt và chậm (13s+) chỉ để làm việc evaluator lẽ ra làm được.
- Final report: `agent-goal-loop.ts:2253-2275` — `FINAL_REPORT_MAX_ATTEMPTS` (3) với **cùng một model** đã đang chết (breaker mở) → 3 lần fail là tất yếu → fallback BUG-024 in: thought cuối + "⚠️ Vòng lặp mục tiêu dừng sau 6/12 chu kỳ… (evaluator lỗi…)" — **không chứa task_summary, không chứa kết quả nghiên cứu, không chứa danh sách todo mở** — dù toàn bộ dữ liệu đó có sẵn server-side.
- Utility-core (nén context, memory-extraction) bị zen free-tier chặn → LLM digest fail → heuristic fallback (chạy được nhưng chất lượng digest giảm — góp phần vào P2).

**Gốc rễ:** Budget và retry policy của các đường "chấm điểm/tổng kết" được tune cho model không-reasoning và single-provider; model reasoning (glm-5.3-flash) đốt chung pool max_tokens cho suy luận; không có retry ladder đa model cho các đường CỐT LÕI (evaluator, final report) dù hệ thống có sẵn pool 4 model NIM + 2 Zen.

**Hệ quả quy trình:** Verdict rỗng → chu kỳ rác (toàn bộ context re-send để rồi "CHƯA ĐẠT (evaluator lỗi)") → stall brake dừng run → final report rỗng nội dung. Người dùng trả 2,4M token và nhận về 1 thông báo lỗi chung chung.

---

### P4. Sub-agent loop: KHÔNG nén context giữa chừng + quy trình tool rời rạc → tích luỹ token bậc 2

**Hiện tượng:** ALISTA-2 đốt **1.634.491 tokens theo run_end trace / 1.624.752 theo `result.goalLoop.subagentTokens`** (delta ~9,7K ≈ token trọng tài chỉ nằm trong số run_end) — **48 vòng / 7,6 phút** cho một tác vụ khảo sát DB 6 nhóm truy vấn — 67% tổng run. KPI §6 quy định đo bằng trường `subagentTokens` (field có sẵn, không tính trọng tài).

**Bằng chứng:**
- `subagent-delegate.ts` **không hề gọi `compressConversation`** (grep toàn file: 0 kết quả) — chỉ có cap theo-message (`capAssistantContentForTranscript`, `truncateToolMessageJson`). Goal-loop cha CÓ nén (4 lần × 22-27K); sub-agent thì không → mỗi vòng gửi lại TOÀN BỘ lịch sử tăng dần → **chi phí bậc 2 theo số vòng**: 48 vòng × context trung bình ~34K ≈ 1,6M.
- `.env:361-368`: `SUBAGENT_MAX_ITERATIONS=0` (:361), `SUBAGENT_TOKEN_BUDGET=0` (:366), `SUBAGENT_TIMEOUT_MS=0` (:368) — **vô hạn** (bởi chủ đích "dài hạn, khối lớn" — đúng directive user, giữ nguyên). Cộng hưởng (r43): `SUBAGENT_HARD_CEILING_ITERATIONS=0` (:364) — safety-net dự phòng được thiết kế đúng cho trường hợp "cả 3 cap = 0" (default 200 vòng) cũng đang TẮT hẳn → hiện KHÔNG còn tầng đệm nào giữa "vô hạn" và "agent tự chốt" — S4 soft advisory sẽ lấp đúng khoảng trống này theo đúng tinh thần anti-goal #1.
- Quy trình tool rời rạc: 29 shell calls, mỗi call 1 tiến trình python3 mới + đọc lại schema + 1 truy vấn — trong khi 6 nhóm truy vấn có thể gộp thành 1-2 script batch. 9 `todo_write` riêng lẽ, 2 `todo_read` re-read. Mỗi tool call = 1 vòng LLM round-trip kèm context đầy đủ.
- Delegation brief (do Omega tự viết khi re-dispatch) đã phải chỉ tay: *"dùng python3 sqlite3, đọc schema cột trước bằng cursor.description"* — tức cha đã phải làm công việc của một "process coach" thủ công.

**Gốc rễ:** Vòng ReAct sub-agent kế thừa thiết kế "mỗi vòng 1 tool" từ thời tác vụ nhỏ; không có (a) nén context giữa chừng, (b) khuyến khích batch tool calls (LLM hỗ trợ parallel tool_calls), (c) kỷ luật "gộp truy vấn độc lập vào 1 script". Cap vô hạn + không compression = nút thắt chuyển thành đám cháy token.

**Hệ quả quy trình:** Chi phí nhân theo vòng thay vì theo CÔNG VIỆC. Cùng deliverable (6 entity + báo cáo) có thể đạt ở ~10-15 vòng batch + compression ≈ 400-600K token (−60÷−75%).

---

### P5. Environment friction lặp lại qua các run — không có "environment handbook"

**Hiện tượng (run bằng chứng + tiền nhiệm):**
- `sqlite3` CLI thiếu trong sandbox → run ALISTA-1: 4/4 shell fail "sqlite3: command not found" (100% fail rate, chính là phát hiện #1 trong báo cáo ALISTA!) — run trước (R41-OBSV1, evaluator utility) cũng dính cùng họ lỗi. ALISTA-2 được cứu chỉ vì Omega thủ công ghi workaround vào brief.
- `web_fetch` từ chối URL tương đối ("Invalid URL") — Omega mất 1 call thử đọc trace qua web_fetch trước khi chuyển sang shell.
- ToolMetric ghi đầy đủ lỗi này nhưng không có cơ chế nào chủ động phô ra cho agent run sau (lessons_search có nhưng không được inject tự động).

**Gốc rễ:** Không tồn tại khối "environment briefing" chuẩn trong system prompt sub-agent / delegation template; tri thức môi trường sống rải rác trong Lesson/ToolMetric/trace và chỉ đến được nếu agent chủ động tra. Việc `sqlite3` CLI thiếu là 1 dòng `apt install` — chưa ai cài.

---

### P6. OOM crash-loop hạ tầng — watchdog thua đua kernel

**Hiện tượng (OBSV-RESET3-RUN1 bắt live):** next-server vọt RSS ~2,6GB trên box 4GB → kernel OOM-kill ×2 trong 2 phút (dmesg còn lưu: pid 7549 anon-rss 2.654MB + pid 10027 anon-rss 2.636MB) → job attempts 0→2/2 (lần thử cuối) → ALISTA-1 chết trắng giữa chừng (92s, trace 14 events / 11 tools) → phải re-dispatch (mất ngữ cảnh in-flight, khôi phục thủ công qua trace).

**Gốc rễ:** MemWatchdog kiểm tra 60s/lần với ngưỡng 2400MB — spike nhanh hơn chu kỳ kiểm tra → kernel SIGKILL thắng trước. Toàn bộ chi phí down-cascade (re-dispatch, brief thủ công, chu kỳ hồi phục) đều bắt từ đây.

**Đã mitigation phi-code:** đóng agent-browser chrome (~500MB) giữa run. Chưa sửa gốc.

---

### P7. Todo evidence gate + stall brake — khi ĐƯỜNG bằng chứng gãy thì todo kẹt, run chết vì DELIVERY chứ không phải vì WORK

**Hiện tượng:** Todo `cmveshoai000wsnnhnvj9bpb0` (*"Đánh giá + chốt danh sách lỗi… đóng khi danh sách chốt có căn cứ từ báo cáo ALISTA"*) — đúng đắn về thiết kế nghiệm thu — nhưng mọi đường lấy "căn cứ" đều gãy (P1 search vô hình, P2 báo cáo cắt cụt) → todo kẹt → evaluator chu kỳ sau chấm CHƯA ĐẠT ("còn thiếu: chốt danh sách") → lặp không tiến triển → fingerprint no-progress ×2 + PLANNING-ONLY streak 2 + stall 1/3 → **stall brake CI-1 dừng run 6/12 chu kỳ**.

**Điểm đáng chú ý:** Công việc thực (nghiên cứu) ĐÃ xong từ 05:20 (ALISTA ĐẠT 92%). 40 phút + ~1,5M token sau đó dành cho: truy hồi bằng chứng (P2), chờ evaluator chết (P3), planning-only loop (chu kỳ 5-6 bị ép GĐ2 nhưng 0 tool thành công). Run chết ở khâu **GIAO HÀNG**, không phải khâu LÀM.

**Gốc rễ:** Evidence gate của todo (và evaluator) là consumer của đường bằng chứng — đường này không có SLA "1 bước truy hồi"; khi gãy thì gate biến thành bẫy死. Thiếu cơ chế: (a) todo tự nhận tham chiếu bằng chứng khi delegation kết thúc, (b) evaluator phân biệt được "thiếu bằng chứng vì chưa làm" với "thiếu bằng chứng vì ĐƯỜNG TRUY HỒI gãy".

---

### P8. Quan sát nền còn treo (từ R41-OBSV1 + OBSV-RESET3-RUN1 — chưa xử lý)

| # | Vấn đề | Bằng chứng | Ảnh hưởng quy trình |
|---|---|---|---|
| 8a | SQLite interactive-transaction contention | Prisma Transaction API 5s timeout vs 15s thực tế ở obs-ledger writes (R41-OBSV1, retry transient OK) | Thêm độ trễ + log nhiễu; chưa mất dữ liệu |
| 8b | Zen space-bunny-free free-tier chặn utility-core | 403 FreeTierError (R32, tái xuất run này ×3) — context-compression/memory-extraction rơi heuristic | Giảm chất lượng digest (góp phần P2/P3) |
| 8c | Qdrant collection trống sau reset #3 | 868 chunk R38 mất; health pointCount=0 | Layer chunks của mọi search trả 0 (cộng hưởng P1) |
| 8d | glm-5.3-flash không ổn định kéo dài | R38 hang 196s → R41-OBSV1 starvation → run này breaker mở | Nguyên nhân trực tiếp P3 |

---

## 3. NGUYÊN TẮC THIẾT KẾ (theo directive user — KHÔNG xử lý bằng cap)

1. **Hiệu quả = giảm VIỆC PHẢI LÀM + giảm THÔNG TIN PHẢI GỬI LẠI.** Token tiêu tan đến từ (a) làm lại việc đã làm (hồi phục bằng chứng, re-dispatch, chu kỳ evaluator rác) và (b) gửi lại toàn bộ lịch sử mỗi vòng (không compression, tool rời rạc). Sửa (a)(b) trước — tổng token tự giảm.
2. **Bằng chứng: ghi 1 lần — đọc được ở mọi nơi.** Mọi artifact do hệ thống hoặc agent sinh ra (báo cáo delegation, entity KB, verdict) phải có ≥1 địa chỉ truy hồi nguyên vẹn 1 bước, và đường tra cứu chính thức phải nhìn thấy nó.
3. **Cap chỉ là safety-net, không phải công cụ hiệu quả.** Giữ `SUBAGENT_* = 0` (vô hạn) đúng tinh thần "dài hạn, khối lớn"; thay bằng (a) compression, (b) batching, (c) soft advisory để agent TỰ tối ưu. Nếu cần safety-net cuối thì chỉ intercept khi có dấu hiệu vòng lặp vô ích (fingerprint lặp), không phải cắt ngang đang làm.
4. **Đo lường bằng cycle-waste, không chỉ tổng token.** KPI: số chu kỳ dành cho hồi phục/meta (target 0-1), tỷ lệ verdict null, tỷ lệ final-report có nội dung, sub-agent token trên cùng loại deliverable.
5. **Đường chấm điểm (evaluator/final-report) phải sống sót qua cái chết của 1 model.** Retry ladder đa model là bắt buộc với mọi đường cốt lõi.
6. **Mọi thay đổi phải giữ 2 tầng tuần tự hiện có** (R14 pool 1-slot + R41 dedupe) — blueprint này không đụng concurrency.

---

## 4. GIẢI PHÁP (S1–S8, map 1-1 với P)

### S1. KB write-through + lớp search LocalEntity (fix P1) — **W1, ưu tiên cao nhất**

**Thiết kế 3 lớp (r43: v0.1 có 2 — thêm backfill):**
1. **Write-through Neo4j:** `agentWriteEntity` (knowledge-bridge.ts) sau khi `localEntity.create` → best-effort MERGE lên Neo4j ngay trong cùng call (dùng `safeSession` + **quy ước node id deterministic `global__<entityName>__<entityType>`** — cùng quy ước sync-neo4j route :556-559 để write-through hội tụ về đúng node sẵn có, không đẻ node trùng với đường doc-scope sync; label = entityType, props: description/domain/source; runId/agentName đưa qua `properties` JSON — LocalEntity KHÔNG có cột createdBy/runId riêng nên không cần migration cột mới). Fail Neo4j → KHÔNG fail tool (fail-open, giữ semantics buffer cũ; ghi log `KB write-through degraded`). Đánh dấu `synced:true` + `resolvedEntityId` khi MERGE thành công để sync doc-scope không đếm trùng.
2. **Backfill 1 lần (r43 — thiếu ở v0.1):** mọi entity agent lịch sử `where: {documentId: null, synced: false}` (hiện 6 row — gồm đúng 6 entity run bằng chứng) chạy qua cùng write-through một lần; không backfill thì S1 chỉ fires trên write MỚI và 6 entity cũ vẫn vô hình với `knowledge_graph`. Script 1 lần trong W1, đồng thời là verify nghiệm thu S1 trên chính dữ liệu thật.
3. **Search fallback LocalEntity:** `searchEntitiesForUser` (kb-access.ts:633) thêm nguồn thứ 3: `db.localEntity.findMany({ where: { OR: [{entityName: {contains: q}}, {description: {contains: q}}] }, take: topK, orderBy: createdAt desc })` (SQL LIKE, không cần embedding) — merge vào danh sách semantic+lexical hiện có (score 0.4 — dưới semantic, ngang lexical). Nguồn này luôn chạy — kể cả Neo4j chết — biến LocalEntity từ "buffer mù" thành "tầng KV chắc chắn tìm được".

**Kèm theo:**
- `harvestDelegationLessonToKB` tự hưởng write-through (không đổi code — cùng đi qua `agentWriteEntity`).
- Tool result `knowledge_write` bổ sung 1 dòng: `"Đã ghi entity (tìm lại: knowledge_search theo tên entity; bảng LocalEntity id=…)"` — agent biết ngay đường truy hồi.
- Data-map (data-map.ts:153 `research_kb`) bổ sung ghi chú: *"agent có thể ghi KB chung qua knowledge_write — tìm lại bằng knowledge_search"* — tránh kết luận sai "research_kb riêng" như Omega.

**Verify nghiệm thu:** (1) viết entity mới qua tool → `knowledge_search` theo đúng tên → thấy trong ≤1 call; (2) tắt Neo4j (giả lập) → vẫn thấy qua LIKE layer; (3) `knowledge_graph` STARTS WITH tên → có record.

**Effort:** ~1 ngày code + test (gồm backfill). **Rủi ro (r43 cập nhật):** index `@@index([entityName])` ĐÃ CÓ sẵn (schema:164) — không cần migration, bỏ rủi ro "tạo index" của v0.1; LIKE không phân biệt hoa-thường ASCII trên SQLite (đúng tinh thần "tìm theo tên entity"); traffic search tăng nhẹ (đếm được). Ghi chú scope: LocalEntity không có cột user/agent → kết quả LIKE là KB DÙNG CHUNG toàn hệ thống (đúng tinh thần "KB chung", không scoping theo agent — cần ghi rõ trong docs để không kỳ vọng sai).

---

### S2. Delegation Artifact Store — báo cáo sub-agent sống nguyên vẹn ở 1 nơi có địa chỉ (fix P2) — **W1**

**Thiết kế:**
1. **Lưu nguyên vẹn:** khi delegation kết thúc (`concluded`/`iteration_limit`), lưu FULL report (không cắt) vào `TaskContextArchive` (bảng có sẵn). Mapping theo schema THẬT (r43): `runId` = sub-run id, `agentName` = tên sub-agent, `kind` = `'delegation_report'` (giá trị kind mới — cập nhật doc-comment schema :2031 "digest|raw|task_summary|delegation_report"; prune sweep xóa theo createdAt không phân biệt kind nên không cần đổi), metadata `{parentRunId, verdict, tokens, toolCounts}` JSON vào cột `tags` (String? có sẵn — TaskContextArchive KHÔNG có cột metadata, v0.1 viết như thể có cột metadata riêng — đã sửa). Đây là **single source of truth** cho mọi truy hồi sau này (cha, evaluator, final report, người).
2. **Trace không cắt final report:** thêm event type riêng `final_report` trong agent-run-tracker (cap riêng 32K — đủ mọi báo cáo thực tế) dùng cho message cuối của sub-agent; thought thường giữ cap 2400 như cũ.
3. **Parent biết đường 1 bước:** tool result delegate (giữ cap 9.000) + thought line `dlClip` (nâng 220 → 400) đều nối dòng: `"📌 Báo cáo đầy đủ: context_recall({runId:'sub_…'})"` — đường `context_recall` đã tồn tại (Omega đã dùng 2 lần trong run này; r43 xác nhận `recallContext` hỗ trợ sẵn filter `runId` + `kind` qua params — caller không truyền kind thì không bị lọc loại; SQL LIKE path luôn chạy được kể cả Qdrant chết).
4. **Compression không nuốt artifact:** khi `compressConversation` chạm tool-result của delegation, digest luôn kết thúc bằng dòng tham chiếu artifact (`📌 delegation sub_… → context_recall`) — tham chiếu 1 dòng sống sót mọi lần nén.
5. (Tùy chọn W2) `argsSummary` tracker 200 → 400 cho `knowledge_write` (đủ tên entity trọn vẹn trong trace).
6. (r43) **Mở điều kiện embed Qdrant cho `delegation_report`:** `archiveEvent` hiện chỉ embed `kind='digest'` (context-store.ts:278) — không mở thì delegation report chỉ được tìm qua SQL LIKE path (vẫn dùng được nhưng mất semantic recall); mở 1 dòng điều kiện `kind === 'digest' || kind === 'delegation_report'`.

**Verify:** delegation chạy xong → (1) DB TaskContextArchive có row đầy đủ; (2) `context_recall` trên sub-run id trả báo cáo nguyên vẹn (≥ 6 vấn đề đủ); (3) sau 3 lần nén context, tham chiếu artifact vẫn trong context.

**Effort:** ~1-1,5 ngày. **Rủi ro:** TaskContextArchive phình — cân cleanup policy hiện có (đã có sweep) + cap 32K/report.

---

### S3. Evaluator + final-report sống sót qua model yếu (fix P3) — **W1**

**Thiết kế:**
1. **Model-aware budget:** evaluator `maxTokens` 2000 → hàm nhỏ `verdictBudget(model)`: model trong danh sách reasoning (glm-5.3-flash, space-bunny…) → **8.000** (4× base — vượt hẳn lớp ×2 nội bộ llm.ts R25 mà quan sát cho thấy vẫn cạn); model thường → 2.000. **r43: phải THÊM const `REASONING_MODELS` mới** — v0.1 viết "llm.ts đã có khái niệm model catalog" nhưng catalog r73 không có danh sách reasoning; đặt const mới cạnh catalog. Áp cùng logic cho `CONSULT_MAX_TOKENS` (1100 → 4.000 với reasoning model).
2. **Retry ladder đa model cho evaluator:** attempt 1 = model agent; fail (null/empty/starvation) → attempt 2 = **model khác provider** (theo chính sách R39: nemotron-550b cho đường chấm điểm — chậm 13s nhưng ổn định; r43: nemotron-550b là EXTRACTION single core llm.ts:337 không rotation — dùng cho ladder là cấu hình caller, không đụng pool); fail nữa → heuristic như hiện nay. Bỏ pattern "cùng model chết 3 lần" của final-report: 3 attempt xoay vòng 2-3 model khác nhau + backoff hiện có.
3. **BUG-024 fallback có nội dung (quan trọng nhất với user):** khi mọi LLM attempt fail, final report fallback KHÔNG in "evaluator lỗi" chung chung nữa — build từ dữ liệu server-side có sẵn: task_summary + danh sách todo (đóng/mở kèm lý do) + evidence log đếm + top thought cuối + artifact refs (S2) + đề xuất next action. Mọi thứ đều có trong checkpoint/result — chỉ cần format.
4. (Ghi nhận) Utility-core free-tier (P8b): giữ fail-open heuristic; cân nhắk thêm NIM utility model vào pool utility khi Zen 403 (đã có pool 4 key NIM).

**Verify:** (1) giả lập model chính trả empty ×3 → final report vẫn chứa task_summary + todos + evidence; (2) evaluator với glm-5.3-flash không còn finish=length; (3) verdict null rate < 5%.

**Effort:** ~1 ngày. **Rủi ro:** thêm 1 call model khác khi fail → tăng latency chu kỳ chết (chấp nhận được — hiện tại mất trắng cả chu kỳ).

---

### S4. Sub-agent process: compression + batching + soft advisory (fix P4) — **W2**

**Thiết kế (giữ caps = 0 vô hạn theo directive):**
1. **Compression trong sub-agent loop:** import + gọi `compressConversation` (r43 xác nhận signature có đủ dùng: messages/protectedStartIndex/keepRecent/evidence/onTokens + **`archive: {runId, sessionId, agentName}`** CI-3 B2 — digest vào Kho Context; subagent-delegate đã import 2 hàm khác từ context-compression :63) khi transcript vượt ngưỡng (dùng cùng COMPRESS_THRESHOLD_CHARS) — digest fail-open. Ước tính giảm 40-60% token cho run >20 vòng.
2. **Kỷ luật batching trong prompt delegation template:** thêm 3 dòng vào brief chuẩn: (a) *"Gộp nhiều truy vấn/đọc file độc lập vào 1 script shell duy nhất khi có thể"*; (b) *"Dùng parallel tool_calls trong 1 message cho các tool độc lập"*; (c) *"Trước khi bắt đầu, viết kế hoạch ≤8 bước kèm ước lượng số vòng"*.
3. **Soft-budget advisory (KHÔNG hard cap):** tại mốc vòng 15/25/40, harness inject 1 system-note ngắn: *"Đã N vòng · X tokens — nếu còn >2 nhóm việc, gộp truy vấn và rút gọn"* (advisory-only; agent tự quyết — tôn trọng "không đủ token làm việc" concern của user).
4. **REPEAT_READ guard mở rộng:** Set `READ_REPEAT_TOOLS` (goal-loop :416) đã có — cân nhắk áp tương tự cho sub-agent (chống re-read cùng file/query).

**Verify:** chạy lại tác vụ tương đương (khảo sát 6 nhóm) với sub-agent mới: mục tiêu ≤600K tokens / ≤20 vòng cho cùng deliverable; báo cáo so sánh side-by-side.

**Effort:** ~1,5-2 ngày (compression wiring + template + advisory). **Rủi ro:** compression giữa chừng có thể mất chi tiết — giảm bằng keepRecent cao hơn cho sub-agent + artifact store (S2) bù đắp.

---

### S5. Environment handbook + cài sqlite3 CLI (fix P5) — **W2 (phần cài: W1, 5 phút)**

1. **Cài ngay:** `apt-get install -y sqlite3` (root box) — xoá sẹo cả một họ lỗi (2 run liên tiếp dính).
2. **ENV_BRIEFING khối chuẩn trong sub-agent system prompt** (~10 dòng, từ data-map): môi trường có gì (`bun`, `python3` + sqlite3 module, `sqlite3` CLI sau khi cài), thiếu gì, quirks (`web_fetch` không nhận URL tương đối — đọc file local bằng `file_read`/`shell`), đường DB thật. Cập nhật khi phát hiện quirk mới (1 dòng data-map).
3. **Auto-hint theo pattern lỗi:** khi shell error match "command not found" ×2 cùng lệnh → inject hint 1 lần ("thiếu binary — thử `python3 -c` tương đương hoặc `manage_packages`").

**Verify:** sub-agent mới chạy truy vấn DB mà không có call "sqlite3: command not found" nào.

**Effort:** cài 5 phút + briefing 2-3 giờ. **Rủi ro:** thấp.

---

### S6. MemWatchdog đua thắng kernel (fix P6) — **W2**

1. **Ops ngay — không cần code (r43):** `MEM_WATCHDOG_INTERVAL_MS` đã env-tunable sẵn (min 10s, default 60s — instrumentation-node.ts:127) → set 20-25s trong .env; `MEM_WATCHDOG_MB` là env (default 1700, .env đang 2400) → hạ 1900-2000. Cả 2 chỉ là đổi .env + restart. Hai núm sẵn có khác: `MEM_WATCHDOG_RSS_EXIT_AVAIL_MB` (900) + `MEM_WATCHDOG_GLOBAL_MIN_MB` (450).
2. **Code (đúng phần việc W2):** hành động tier-2 — khi RSS > ngưỡng soft (1600) → chủ động flush + log cảnh báo (giảm GC pressure) trước khi tới hard.
3. Ghi operator playbook vào PLAYBOOK.md: đóng preview browser khi chạy delegation nặng (đã làm ad hoc — chuẩn hoá).

**Verify:** stress test spike bộ nhớ (script sinh load) → watchdog kill/restart app thay vì kernel OOM-kill; job không rơi attempts 2/2 vì OOM nữa.

**Effort:** phần ops 5 phút đổi .env; phần code tier-2 ~nửa ngày. **Rủi ro:** watchdog quá nhạy giết app giữa run lành — cân theo đo đạc thực tế (giữ grace period hiện có cho job đang chạy).

---

### S7. Todo evidence auto-attach (fix P7) — **W2**

**Thiết kế (r43 chốt cơ chế matching cụ thể — điểm yếu nhất của S1-S8, cần chốt trước khi code):** Todo đã có sẵn cột `runId` + `sessionId` + `taskMetaJson` (schema:1033-1036). Rule: khi delegation kết thúc, harness update mọi Todo cùng `runId` mà `content` nhắc tên agent/task đã delegate (match tên thường-hoá) → ghi `taskMetaJson.evidence = { subRunId, artifactRef (S2), verdict, pass, tokens, toolCalls }` (merge — không đè taskMetaJson sẵn có). **Không match được todo nào → record 1 thought hệ thống "delegation X kết thúc, không tìm todo tương ứng"** — không im lặng. Agent đóng todo bằng cách tham chiếu evidence hệ thống gắn (một dòng), không phải tự truy hồi. Evaluator khi kiểm tra todo closure chấp nhận evidence ref hệ thống là "có căn cứ".

**Kèm:** thông điệp evaluator phân biệt 2 trạng thái: *"chưa có bằng chứng vì chưa làm"* (khuyên làm tiếp) vs *"đường truy hồi gãy"* (khuyên fallback: db_query LocalEntity / context_recall artifact) — hint đường thay vì chấm chết.

**Verify:** kịch bản run này chạy lại: sau delegation xong, todo "chốt danh sách" có evidence attach → Omega chốt danh sách trong 1 chu kỳ bằng context_recall + knowledge_search (S1) → todo đóng → evaluator ĐẠT.

**Effort:** ~1 ngày. **Phụ thuộc:** S2 (artifact ref).

---

### S8. Final report content guarantee (fix P2/P3 đuôi) — gộp trong S3.3 (thực thi cùng lúc W1)

Riêng liệt kê để nhấn mạnh nghiệm thu user-facing: **bất kể LLM sống chết, người dùng KHÔNG BAO GIỜ nhận về báo cáo rỗng nội dung** — tối thiểu: mục tiêu + những gì đã làm (evidence log) + danh sách todo mở kèm lý do + nơi lấy đầy đủ (artifact refs) + next action đề xuất. Đã mô tả cơ chế ở S3.3.

---

## 5. LỘ TRÌNH TRIỂN KHAI

| Wave | Nội dung | Lý do thứ tự | Effort |
|---|---|---|---|
| **W1 — Sửa đường bằng chứng (chặn chuỗi thất bại của run này)** | S1 (KB write-through + search + backfill) · S2 (artifact store + trace không cắt) · S3 (evaluator budget/ladder + final report có nội dung) · S5.1 (cài sqlite3) · S6-ops (đổi .env watchdog, 5 phút) | Đây là 4 điểm gãy trực tiếp tạo ra báo cáo Omega user trích — sửa trước để mọi run sau giao hàng được | ~3-4 ngày |
| **W2 — Hiệu quả quy trình (giảm token/thời gian theo directive)** | S4 (sub-agent compression + batching + advisory) · S5.2-3 (env briefing + auto-hint) · S6 (watchdog) · S7 (todo evidence attach) | Sau khi đường bằng chắc, tối ưu chi phí; S7 cần S2 | ~4-5 ngày |
| **W3 — Nền (P8)** | 8a retry/transaction policy rà lại · 8b utility model NIM backup · 8c qdrant re-ingest theo playbook D0 §7.2 (chờ user quyết) · 8d cân chính sách model evaluator dài hạn | Không chặn W1/W2 | theo lịch riêng |

**Không đổi:** concurrency 2 tầng (R14 pool 1-slot + R41 dedupe) · `SUBAGENT_* = 0` (vô hạn) · giao thức quan sát (đã bắt trọn sự cố này — giữ nguyên).

---

## 6. KPI NGHIỆM THU

| KPI | Hiện trạng (run bằng chứng) | Mục tiêu sau W1+W2 |
|---|---|---|
| knowledge_write → knowledge_search cùng run | 0/6 tìm thấy | **100%** tìm thấy ≤1 call |
| Truy hồi báo cáo delegation nguyên vẹn | 0 đường (tốt nhất 2.400 ký tự cắt cụt) | **1 bước** (context_recall/artifact) |
| Chu kỳ dành cho hồi phục bằng chứng / meta | 4/6 | **≤1** |
| Evaluator verdict null rate | ~33% (2/6 chu kỳ "evaluator lỗi") + starvation ×2 run trước | **<5%** |
| Final report chứa nội dung công việc khi LLM chết | 0% (generic error) | **100%** |
| Sub-agent token cho tác vụ khảo sát tương đương — đo bằng `result.goalLoop.subagentTokens` (r43) | 1,63M / 48 vòng | **≤600K / ≤20 vòng** |
| Job chết vì OOM giữa delegation | 2/2 attempts (run này) | **0** |
| Todo delegation đóng bằng evidence hệ thống | Không tồn tại cơ chế | **≥90% delegation có evidence attach** |

---

## 7. NHỮNG GÌ KHÔNG LÀM (anti-goals — theo directive user)

1. **KHÔNG hạ `SUBAGENT_MAX_ITERATIONS/TOKEN_BUDGET/TIMEOUT`** từ 0 (vô hạn) — cap cứng tạo bệnh "không đủ token làm việc" mà user chỉ rõ. Thay bằng S4 (compression/batching/advisory) — giảm token bằng giảm việc + giảm gửi lại.
2. **KHÔNG cắt tool-result của delegation xuống nhỏ hơn** — hướng đi ngược: lưu nguyên vẹn ở nơi có địa chỉ (S2) và cắt CÓ Ý THỨC ở tầng hiển thị.
3. **KHÔNG đổi concurrency** — tuần tự 1-agent/lượt là directive đã chốt (R14/R41), hiệu quả phải đạt trong ràng buộc đó.
4. **KHÔNG thêm provider mới / model mới** để xử lý P3 — pool 4 NIM + 2 Zen hiện có đủ nếu có retry ladder + budget đúng.
5. **KHÔNG xử lý P8c (re-ingest Qdrant) trong blueprint này** — chờ user quyết theo playbook D0 §7.2 (S1 phần search-LIKE không phụ thuộc Qdrant nên không bị chặn).

---

## 8. PHỤ LỤC — TÁI HIỆN ĐIỀU TRA

```bash
# 1. Xem 6 entity ALISTA trong DB (đủ tên + mô tả — bằng chứng P1)
bun -e 'import {PrismaClient} from "@prisma/client";
const db = new PrismaClient({datasources:{db:{url:"file:/home/z/tmo-app/db/custom.db"}}});
const es = await db.localEntity.findMany();
console.log(es.length, es.map(e=>[e.id,e.entityName,e.synced]));
await db.$disconnect()'

# 2. Tái hiện knowledge_search không thấy 6 entity (bằng chứng P1)
#    (script gọi agentKnowledgeSearch với query giống Omega — kết quả: 10-12 entity cũ Neo4j, 0/6 ALISTA)

# 3. Xem tầng cắt báo cáo trong trace (bằng chứng P2)
python3 -c "
import json
for line in open('agent-runs/sub_1792386783023_1.jsonl'):
    ev = json.loads(line)
    if ev.get('type')=='thought' and 'BÁO CÁO NGHIÊN CỨU' in str(ev.get('text','')):
        print('len:', len(ev['text']))   # → 2401 (cap THOUGHT_MAX_CHARS=2400, đứt giữa vấn đề 2/6)
"

# 4. Todo kẹt + kết thúc run (bằng chứng P7)
#    Todo id đầy đủ: cmveshoai000wsnnhnvj9bpb0 — status failed, updatedAt 05:59:26 (đóng cơ học lúc run chết)

# 5. Token phân bổ (bằng chứng P4)
#    result.goalLoop.tokensUsed = 2.432.847 · subagentTokens = 1.624.752 (67%) · escalations = 1
```

**Bảng tham chiếu code (HEAD 067c56f / R41):**

| Điểm gãy | File:dòng |
|---|---|
| Write entity → buffer mù | src/lib/knowledge-bridge.ts:353-373 |
| Sync chỉ theo document | src/app/api/sync-neo4j/route.ts:221 |
| Search không đọc LocalEntity | src/lib/kb-routing/kb-access.ts:633 (searchEntitiesForUser → Neo4j) |
| Trace thought cap 2400 | src/lib/agent-run-tracker.ts:182 |
| Parent thought clip 220 | src/lib/agent-goal-loop.ts:1400 |
| Delegate report cap 9000 | src/lib/subagent-delegate.ts:146 |
| KB digest cap 700 | src/lib/subagent-delegate.ts:2094 |
| Evaluator single-attempt 2000 | src/lib/agent-goal-loop.ts:2126-2137 |
| Consult maxTokens 1100 | src/lib/omega-orchestrator.ts:64 |
| Final report 3-attempt cùng model | src/lib/agent-goal-loop.ts:2253-2275 |
| Sub-agent loop không compression | src/lib/subagent-delegate.ts (grep `compressConversation` = 0; :63 chỉ import 2 hàm cap per-message) |
| Caps sub-agent = 0 (vô hạn, gồm cả hard ceiling :364) | .env:361/:364/:366/:368 |
| Retry ×2 nội bộ khi reasoning hết (nguồn số "4000") | src/lib/llm.ts:2931/:2994 (R25) |
| Node id Neo4j deterministic `global__<name>__<type>` (quy ước MERGE S1) | src/app/api/sync-neo4j/route.ts:556-559 |
| Embed archive chỉ kind='digest' (S2.6 cần mở) | src/lib/context-store.ts:278 |
| recallContext filter runId/kind theo params (S2.3 dựa trên đây) | src/lib/context-store.ts:471-482 |
| Watchdog interval env-tunable min 10s (S6-ops) | src/instrumentation-node.ts:127 |

---

## 9. LỊCH SỬ HIỆU ĐỈNH — r43 REVIEW (v0.1 → v0.2)

**Phương pháp review (vai kỹ sư AI + kiến trúc sư hệ thống):** đọc toàn văn 389 dòng v0.1 → đối chiếu **12/12 điểm gãy** của §8 với code thật tại HEAD 20aaa05 từng dòng (`sed`/`grep` tại đúng số dòng) → parse lại cả 3 trace JSONL + query DB (LocalEntity / ResearchKBEntry / Todo / GoalLoopJob result) → đo lại mọi con số định lượng → đánh giá thiết kế S1-S8 theo khả năng tích hợp với schema/contract có sẵn. **Kết luận tổng: cấu trúc P/S/W ĐÚNG và giữ nguyên — không phát hiện nào làm đổ chẩn đoán; 16 hiệu đính đều thuộc loại tăng độ chính xác / khả năng tích hợp / trung thực số liệu.**

**Bảng 12/12 điểm gãy §8 — verify khớp code:** mọi file:dòng đúng như v0.1 trích (knowledge-bridge:353 · sync-neo4j:221 · kb-access:633 · tracker:182/:1019 · goal-loop:1400/:2126/:2253 · orchestrator:64 · delegate:146/:2094 — grep compressConversation=0 xác nhận · .env:361-368). Trace + DB đo lại khớp: 6 LocalEntity (desc 195-1.054) · ResearchKBEntry=0 · argsSummary 6/6=150 · thought=2401 (=2400+"…") · run_end 87 chars "concluded · 48 vòng · 47 tools · 1634491 tokens · ĐẠT 92%" · Omega 108 events/58 thoughts/37 tool events (36 executed) · context_recall ×2 + knowledge_search ×3 + knowledge_graph ×1 · iterations 22 · tokensUsed 2.432.847 · subagentTokens 1.624.752 · stopReason no_progress · Todo failed 05:59:26 · dmesg 2 kill (rss 2.654MB + 2.636MB).

**16 hiệu đính v0.2:**

| # | Phát hiện review | Mức | Sửa ở |
|---|---|---|---|
| 1 | P2 tự mâu thuẫn "5 tầng" (§0+heading) vs bảng 6 hàng | P3 | §0, heading P2 → "6 tầng" |
| 2 | §0 bảng token kép: 3 hàng ngầm cộng được nhưng 808.095 + 1.624.752 + 10.132 ≠ 2.432.847 (consult ĐÃ nằm trong parent) | P3 | §0 bảng |
| 3 | 2 nguồn số sub-agent tokens chưa giải thích: 1.634.491 (run_end, OBS-ALERT) vs 1.624.752 (job result) — delta ~9,7K ≈ token trọng tài; KPI chưa quy định trường đo | P3 | §0, §1.1, P4, §6 KPI |
| 4 | "max_tokens=4000" không giải thích được từ code (call-site 2000): thực ra llm.ts R25 tự retry ×2 nội bộ — lỗi in budget SAU nhân đôi; lớp ×2 ĐÃ tồn tại mà vẫn cạn (củng cố S3) | P2 | P3.1 + P3 bằng chứng |
| 5 | S2.1 viết "metadata" như thể TaskContextArchive có cột metadata — schema chỉ có `tags` (String?) | P2 | S2.1 (metadata JSON vào tags) |
| 6 | `archiveEvent` chỉ embed Qdrant kind='digest' (context-store:278) → 'delegation_report' mất semantic recall nếu không mở điều kiện | P2 | S2 thêm mục 6 |
| 7 | S1.1 MERGE không chỉ định quy ước node id — sync route dùng deterministic `global__<name>__<type>` (:556-559); MERGE theo name thuần sẽ đẻ node trùng | P2 | S1.1 |
| 8 | S1.1 props "createdBy/runId" không tồn tại ở schema/agentWriteEntity signature | P3 | S1.1 (qua properties JSON) |
| 9 | S1 thiếu backfill: 6 entity cũ vẫn vô hình với knowledge_graph sau deploy (write-through chỉ fires write mới) | P2 | S1 thêm mục 2 |
| 10 | S1 rủi ro "tạo @@index([entityName])" — index ĐÃ CÓ sẵn (schema:164) | P4 | S1 rủi ro |
| 11 | S6 đánh đồng ops/code: MEM_WATCHDOG_INTERVAL_MS + MEM_WATCHDOG_MB đều env-tunable sẵn (instrumentation:127) — đổi interval/threshold chỉ 5 phút .env, không cần code | P3 | S6 tách ops/code |
| 12 | P4 ".env cả 3 cap" thực ra 4 cap=0 — SUBAGENT_HARD_CEILING_ITERATIONS (:364, default 200) cũng TẮT → không còn tầng đệm nào; trung thực hóa anti-goal #1 | P3 | P4 + §8 |
| 13 | Chuẩn số liệu nhỏ: argsSummary "~120-200" → đo lại 6/6=150; Omega "36 tool calls" (DB) vs 37 tool events (trace — web_fetch fail); thought 2401=2400+"…" | P4 | §1.1, §1.2, P2 tier 1/6 |
| 14 | S7 linkage mơ hồ nhất ("match theo taskMeta/idempotency hoặc todo liên quan chu kỳ") — điểm yếu nhất S1-S8; cần rule cụ thể + hành vi không-match | P2 | S7 (rule runId + content match + thought khi không match) |
| 15 | S3.1 "llm.ts đã có model catalog" — catalog r73 có nhưng KHÔNG có danh sách reasoning; phải thêm const REASONING_MODELS mới | P3 | S3.1 |
| 16 | §1.1 dòng thời gian "05:20–05:19" đảo ngược (typo) | P4 | §1.1 |

**Nhận định kiến trúc tổng thể (giữ nguyên):** chuỗi P1→P7 là một causal chain duy nhất (đường bằng chứng gãy → todo kẹt → evaluator rác → stall brake → final report rỗng) — sửa theo W1 là đúng thứ tự nhân quả. Không phát hiện nào đòi thay đổi map 1-1 P↔S, không đòi thêm provider/migration cột mới, không vi phạm 6 nguyên tắc §3 và 5 anti-goals §7.

---

*Blueprint này là kết quả điều tra trực tiếp trên hệ thống đang chạy (không suy đoán): tái hiện được lỗi search, đo được từng tầng cắt, trích được từng mệnh đề trong báo cáo cuối của Omega đối chiếu với DB + trace + code. Mọi con số đều có địa chỉ file:dòng hoặc lệnh tái hiện ở Phụ lục. Bản v0.2 đã qua review đối chiếu độc lập (r43) — mọi tuyên bố đều được verify lại theo đúng số dòng/lệnh trước khi hiệu đính.*
