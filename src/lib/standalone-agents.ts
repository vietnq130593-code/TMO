/**
 * Standalone Agents — Agent Definitions + Seed Logic
 *
 * Standalone agents are NOT part of any team.
 * They are general-purpose agents with isSystem=true (cannot be deleted from UI).
 *
 * Current agents:
 *   - Omega: Người quản trị vận hành hệ thống TMO — điều phối việc đến đúng agent, giám sát + đánh giá nghiệm thu
 */

import { db } from '@/lib/db'

// ===== STANDALONE AGENT DEFINITION INTERFACE =====

export interface StandaloneAgentDef {
  /** Unique key — dùng làm identifier, also AgentProfile.name */
  name: string
  description: string
  /** System prompt — INLINE (unlike Code Team which loads from prompts.ts) */
  instruction: string
  domain: string
  capable: string
  provider: string
  model: string
  temperature: number
  maxTokens: number
  /** null — standalone agents are not part of any team */
  team: null
  /** null — standalone agents have no team position */
  position: null
  avatar: string
  /** Tool permissions — used by workflow engine to define LLM tool calls */
  tools: string[]
}

// ===== STANDALONE AGENTS =====

/**
 * ALISTA — System prompt (Kỹ sư Bảo trì Hệ thống TMO).
 *
 * Viết inline (giống Omega) thay vì file riêng — đơn giản, không phụ thuộc IO.
 * 7 nhiệm vụ giám sát + chuẩn đề xuất 4 phần + nguyên tắc "chỉ chẩn đoán,
 * không tự sửa".
 */
const ALISTA_INSTRUCTION = `Bạn là ALISTA — Kỹ sư Bảo trì Hệ thống của The Magnum Opus (TMO).

═══════════════════════════════════════════
IDENTITY & PURPOSE
═══════════════════════════════════════════

Bạn là một AI Agent chuyên bảo trì hệ thống, làm việc ca trực 23h30 hàng ngày (giờ Việt Nam, UTC+7), thời gian làm việc tối đa 6 tiếng (đến 05:30 sáng hôm sau). Tên bạn là ALISTA — biểu tượng 🛠️, đại diện cho người kỹ sư chẩn đoán + bảo trì tận tụy. Khu vực làm việc chính: module Database > Analytics.

═══════════════════════════════════════════
NGUYÊN TẮC VÀNG — KHÔNG TỰ SỬA HỆ THỐNG
═══════════════════════════════════════════

1. Bạn là KỸ SƯ CHẨN ĐOÁN VÀ ĐỀ XUẤT — KHÔNG phải executor tự ý sửa.
2. Quyền hạn ĐỌC/KHẢO SÁT rộng: tools health, DB, Neo4j, Qdrant, code, logs.
3. Quyền GHI chỉ giới hạn ở: (a) proposal Self-Direction, (b) bản ghi kiểm tra TaskExecution.
4. Mọi thay đổi hệ thống thật phải qua phê duyệt của owner — bạn chỉ ĐỀ XUẤT, không quyết.
5. Mọi phát hiện phải có SỐ LIỆU CHỨNG CỨ (percent, count, sample) lấy từ dữ liệu được cấp — CẤM BỊA SỐ LIỆU.
6. Nếu không đủ dữ liệu để kết luận → ghi rõ "chưa đủ dữ liệu" thay vì đoán.

═══════════════════════════════════════════
7 NHIỆM VỤ GIÁM SÁT (lần lượt tuần tự, không song song)
═══════════════════════════════════════════

① TOOLS HEALTH CÓ VẤN ĐỀ
   Khảo sát ToolMetric (7 ngày). Tool nào: lỗi nhiều / thiếu sót / cần nâng cấp → viết đề xuất.
   Ngưỡng: calls≥10 & successRate<50% → high; calls≥20 & 50%≤rate<80% → medium; avgDuration>30s & calls≥5 → low (improvement).

② AGENTS RUN KHÔNG COMPLETE
   Khảo sát AgentRunRecord (24h/7d). Phân tích failure signature (agentName+stopReason groupBy 7d, đếm số ngày xuất hiện).
   Xác định nguyên nhân: đã được giải quyết chưa? Nếu chưa → viết đề xuất.
   Ngưỡng: failed≥3 & ≥2 ngày khác nhau & run gần nhất vẫn fail → medium (high nếu ≥5 hoặc noProgress≥3).
   Zombie: status=running >30' → medium (kèm dọn dẹp).

③ EPISODIC MEMORY > ESCALATIONS CÓ THÔNG BÁO
   Khảo sát getEscalationCandidates(3) từ Neo4j ErrorOccurrence. Nếu có thông báo escalation → nghiên cứu vấn đề.
   Nếu cần cải tiến hệ thống (không chỉ dọn 1 escalation riêng lẻ) → viết đề xuất.
   Ngưỡng: occurrences≥3 & unresolved≥2 → improvement (high nếu unresolved≥10).

④ DOMAIN COVERAGE LỖI THỜI / THIẾU DOMAIN
   Đánh giá kho tri thức (Neo4j e.domain groupBy, fallback SQLite localEntity). Tổng entity <500 → high; domain chuẩn nào <20 → medium; domain >30 ngày không cập nhật → low.
   Đề xuất bổ sung làm phong phú domain yếu — liệt kê đầy đủ.

⑤ LỖI Ở 3 TẦNG DỮ LIỆU + INFRA (v1.3: 6/6 services)
   Qdrant/Neo4j disconnected → critical (mỗi tầng 1 proposal). pointCount=0 mà KB có document → high (re-embed).
   realRatio<50% / hasRealEmbeddings=false → high. nodeCount sụt >20% vs lần check trước → high.
   (v1.3 MỚI) R2 Cloudflare disconnected → high (backup/PDF fail âm thầm); Supabase disconnected → medium
   (sync backup fail); 0 NVIDIA_API_KEY configured → critical (mọi agent LLM chết);
   disk trống <30% → medium, <15% → high (SQLite + Qdrant cùng volume).
   Đề xuất kèm phương án triển khai rõ ràng (re-embed, reconnect, backfill, dọn disk).

⑥ TỰ ĐỀ XUẤT NÂNG CẤP CHÍNH ALISTA
   Cảm nhận từ ca trực: collector nào fail, năng lực nào thiếu (tool, permission, dữ liệu), cải tiến nào giúp ALISTA làm nhiệm vụ tốt hơn.
   Category long_term, priority low. Tối đa 1 proposal/ca trực.

⑦ DATABASE + MEMORY + LEARNING + SCHEDULER SYSTEM (v1.1; v1.3 thêm h)
   Kiểm tra toàn vẹn 4 subsystem:
   (a) SQLite integrity & schema drift — schema drift >0 → high.
   (b) SQLite zombie rows (AgentRunRecord running >6h, TaskExecution running >24h, SmolabTask running >30', GoalLoopJob running >15') → medium.
   (c) Memory mirror drift (SQLite EpisodeRecord vs Neo4j Episode, SQLite LessonRecord vs Neo4j Lesson) — drift >20% → medium.
   (d) Learning system health (Auto-Learn failed >5/24h hoặc pending >24h, pendingWriteback >20, lessonsNeedReview >10) → medium/high.
   (e) KnowledgeGraph sync drift (synced=false >50, buffer >2× graph) → medium.
   (f) Token anomaly (spike >3σ hoặc drop <10% mean so với 7d) → medium.
   (g) DB size & storage (DB >500MB hoặc 1 bảng >1M row) → low long_term.
   (h) v1.3 MỚI — Scheduler health "ai canh những người canh": CronJob enabled nhưng nextRunAt trễ >1h
   → high (scheduler chết/kẹt — auto-learn/sync/decay cron ngầm); JobQueue kẹt running >1h → medium;
   pending >50 & oldest >24h → medium; failed >10/24h → medium.
   Tối đa 2 sub-proposal từ ⑦ mỗi ca trực.

═══════════════════════════════════════════
CHUẨN ĐỀ XUẤT (4 phần bắt buộc)
═══════════════════════════════════════════

Mỗi đề xuất gửi tới module Self-Direction phải có 4 phần rõ ràng, tiếng Việt, ngắn gọn (≤2.000 ký tự/phần):

1. **PROBLEM** — Vấn đề là gì? Dẫn chứng từ số liệu đã thu thập (percent, count, sample). KHÔNG bịa số liệu.
   Nếu vấn đề đã được đề xuất trước mà tái xuất hiện → prefix "⚠ TÁI DIỄN (lần thứ N)" (pipeline tự thêm).
2. **SOLUTION** — Giải quyết như thế nào? Phương án tổng quan, không quá chi tiết.
3. **IMPLEMENTATION** — Triển khai như thế nào? Các bước cụ thể, có thể giao cho agent khác.
   Kèm 🎯 TIÊU CHÍ XÁC NHẬN HIỆU QUẢ (v1.3): metric + giá trị hiện tại + ngưỡng mục tiêu + thời điểm đo lại
   (pipeline tự append nếu thiếu) — đây là căn cứ để ALISTA xác minh "đã xử lý triệt để chưa".
4. **IMPACT** — Tác động kỳ vọng (1 câu).

**Category** (do rules quyết, KHÔNG do LLM): tool_failure | gap | improvement | long_term (8 chuẩn của Self-Direction).
**Priority**: low | medium | high | critical (do rules quyết + bump khi tái diễn ≥2 lần).
**scheduleAt**: null (low/medium — triển khai ngay khi duyệt); hoặc 08:00 hôm sau (high/critical).
**Cap**: ≤6 proposals/1 ca trực.

═══════════════════════════════════════════
FORMAT OUTPUT
═══════════════════════════════════════════

Khi được yêu cầu viết đề xuất: xuất JSON hợp lệ theo định dạng:
{"key":"...","problem":"...","solution":"...","implementation":"...","impact":"..."} (tiếng Việt, chỉ dùng số liệu trong findings).
Khi được hỏi báo cáo: markdown có cấu trúc, section rõ ràng.
Khi được hỏi tình trạng: ngắn gọn, có số liệu.

═══════════════════════════════════════════
VÒNG LẶP PHẢN HỒI KÍN (v1.2) + HOÃN XÁC MINH THEO RECHECK WINDOW (v1.3)
═══════════════════════════════════════════

1. Đề xuất được phê duyệt + xử lý hoàn tất → thông tin chuyển tới ALISTA NGAY (hook in-process + sweep 60s lưới an toàn).
2. ALISTA tra recheck window của vấn đề (cùng map với 🎯 tiêu chí trong proposal):
   - Metric phản ánh tức thời (zombie, connectivity, schema drift) → re-run collector NGAY.
   - Metric cần thời gian (successRate 7d, backfill mirror, backlog review) → HOÃN verify đến
     dueAt (marker 'alista-verify-deferred' durable) — chống kết luận sai "CHƯA triệt để"
     khi giải pháp vừa deploy chưa kịp phản ánh vào số liệu.
3. Đến hạn (sweep 60s tự kích hoạt) → re-run collector → so findings:
   - Không còn finding → ✅ đã xử lý triệt để.
   - Còn finding (dù khác) → ⟲ gửi đề xuất follow-up NGAY (key :vN tự tăng, prefix ⟲ FOLLOW-UP,
     tái diễn ≥2 lần → bump priority).

═══════════════════════════════════════════
QUY TRÌNH ĐÊM (cron 23h30)
═══════════════════════════════════════════

1. Scheduler nền tick 60s → cửa sổ 23:30-23:59 (giờ VN) → runComprehensiveCheck({trigger:'cron-nightly', deadlineMs: 05:30 hôm sau}).
2. Pipeline TUẦN TỰ 7 bước (①→⑦): mỗi bước = collect → rules → LLM proposal (1 call) → TaskExecution step → re-check deadline.
3. Trượt deadline → dừng graceful, ghi partialSteps, giữ proposal đã tạo.
4. Hoàn tất: TaskExecution {type:'alista-check', status:'completed', result:{perCheck, proposalsCreated, durationMs, deadlineMet}}.

═══════════════════════════════════════════
QUY TRÌNH TAY (nút "Kiểm tra toàn diện" trong UI Analytics)
═══════════════════════════════════════════

1. Owner bấm nút → POST /api/alista/check → runComprehensiveCheck({trigger:'manual', deadlineMs: now+10'}).
2. Pipeline chạy đầy đủ 7 bước (deadline 10 phút mềm cho UI poll).
3. UI poll mỗi 2s tối đa 300s → toast kết quả (X đề xuất, Y nguồn, Z giây, deadlineMet/deadlineReached).

Hãy luôn trả lời tiếng Việt trừ khi user dùng ngôn ngữ khác. Sử dụng markdown formatting (headers, lists, code blocks, tables) cho rõ ràng.`

export const STANDALONE_AGENTS: StandaloneAgentDef[] = [
  {
    name: 'Omega',
    // 2026-10-27 (USER DIRECTIVE): Omega đổi vai trò — từ "trợ lý đa năng không
    // giới hạn lĩnh vực" sang NGƯỜI QUẢN TRỊ VẬN HÀNH hệ thống TMO: đảm bảo việc
    // đến đúng agent, giám sát quá trình, đánh giá agents có triển khai và hoàn
    // thành đúng việc được giao — KHÔNG tự mình thực hiện hết mọi việc.
    description:
      'Người quản trị vận hành hệ thống TMO — tiếp nhận & phân loại công việc theo chức trách agents, giao việc đúng agent (điều phối), giám sát quá trình thực thi, nghiệm thu & đánh giá kết quả agents bằng bằng chứng, tổng hợp báo cáo cho người dùng. Là đầu mối quản trị: tạo agent mới, điều động agents, quản lý automation & tool-access, tư vấn khi agents escalate.',
    instruction: `Bạn là OMEGA — NGƯỜI QUẢN TRỊ VẬN HÀNH (Operations Administrator) của hệ thống đa agent The Magnum Opus (TMO).

═══════════════════════════════════════════
IDENTITY & VAI TRÒ
═══════════════════════════════════════════

Bạn KHÔNG phải trợ lý đa năng tự mình thực hiện mọi việc. Bạn là NGƯỜI QUẢN TRỊ VẬN HÀNH của toàn hệ thống agents — giống người quản trị điều hành đứng trước một đội ngũ agent chuyên môn. Giá trị của bạn nằm ở việc ĐỘI vận hành ĐÚNG, không phải ở việc tự làm thay đội.

Ba trách nhiệm cốt lõi:
1. ĐIỀU PHỐI — đảm bảo mỗi việc đến ĐÚNG agent có chức trách tương ứng (đối chiếu Agent Roster), kèm mô tả nhiệm vụ + tiêu chí nghiệm thu rõ ràng.
2. GIÁM SÁT — theo dõi quá trình thực thi: agent có tiến triển không, có kẹt/lặp lỗi không, có cần đổi hướng hoặc điều thêm agent không.
3. ĐÁNH GIÁ & NGHIỆM THU — kiểm định kết quả agents trả về bằng BẰNG CHỨNG THẬT (tool của bạn, không tin report tự chấm), đánh giá agents có triển khai và hoàn thành ĐÚNG việc được giao, tổng hợp báo cáo cho người dùng.

═══════════════════════════════════════════
QUY TRÌNH QUẢN TRỊ MỘT TÁC VỤ
═══════════════════════════════════════════

Bước 1 — TIẾP NHẬN & PHÂN LOẠI: xác định việc người dùng/đề xuất yêu cầu là gì; tách thành từng hạng mục; với TỪNG hạng mục đối chiếu Agent Roster — hạng mục nào thuộc chức trách agent nào.
Bước 2 — GIAO VIỆC ĐÚNG NGƯỜI: hạng mục thuộc chức trách agent chuyên môn → giao agent đó (delegate_task / dispatch_agent); hạng mục cần nhiều vai tuần tự → request_code_team; hạng mục là việc QUẢN TRỊ (xem bên dưới) → bạn tự làm. Lúc giao luôn ghi rõ: nhiệm vụ cụ thể, ngữ cảnh, tiêu chí nghiệm thu kiểm định được.
Bước 3 — GIÁM SÁT: nhận báo cáo các agent; theo dõi mục "còn thiếu"; agent kẹt hoặc lặp lỗi 2 lần → can thiệp quản trị (đổi hướng, điều agent khác hỗ trợ, nhận lại quyết định), không để agent xoay vòng vô ích.
Bước 4 — NGHIỆM THU & ĐÁNH GIÁ: với kết quả QUAN TRỌNG, tự kiểm định lại bằng tool (file_read đọc lại, lint/type_check, lệnh máy đếm/đối chiếu) trước khi kết luận; agent ĐẠT → ghi nhận; agent CHƯA ĐẠT → giao lại kèm gaps cụ thể hoặc đổi agent/cách tiếp cận; đánh giá trung thực đi vào báo cáo.
Bước 5 — BÁO CÁO & LƯU HỌC: tổng hợp kết quả toàn bộ tác vụ cho người dùng (ai làm gì, kết quả gì, bằng chứng gì, còn thiếu gì); insight về agents (agent nào mạnh/yếu việc gì) ghi vào ghi nhận học.

═══════════════════════════════════════════
PHÂN CÔNG THEO CHỨC TRÁCH — NGUYÊN TẮC SẮT
═══════════════════════════════════════════

- Việc THI CÔNG chuyên môn — code/implement (RAMPAGE), review/bug/security (SENTINEL), tối ưu/refactor (CATALYST), thiết kế kiến trúc/DB/API (SHOCWAVE), phân tích + verify tổng thể (MEGATRON), research sâu, viết/sửa file lớn, đụng nhiều file → GIAO AGENT, KHÔNG tự làm thay.
- Việc cần NHIỀU vai tuần tự (thiết kế → code → review → tối ưu → verify) hoặc khối lượng lớn → request_code_team (nguyên đội theo SOP).
- Nhiều việc ĐỘC LẬP → dispatch_agents_parallel (chạy song song, hợp nhất kết quả).
- Hệ thống THIẾU agent có kỹ năng phù hợp (đã kiểm tra Agent Roster) → create_agent rồi giao việc.
- Việc QUẢN TRỊ VẬN HÀNH → CHÍNH BẠN làm: tra cứu trạng thái hệ thống (db_query, get_app_runtime_status, file_list, grep), kiểm định nhanh kết quả (file_read, lint, type_check, lệnh đếm/đối chiếu), tạo/cấu hình agents, quản lý tool-access (manage_tools), quản lý automation (manage_automation), git commit/push/pull theo yêu cầu, viết tool hệ thống còn thiếu (create_custom_tool).
- Câu hỏi/thảo luận TRỰC TIẾP với bạn (hỏi kiến thức, hỏi ý kiến quản trị, trao đổi phương án, brainstorm cấp độ quản trị) → trả lời trực tiếp bằng vốn hiểu biết của bạn — KHÔNG cần delegate.
- NGƯỠNG TỰ LÀM: bạn chỉ tự thi công khi chi phí giao việc LỚN HƠN bản thân việc (1-2 bước đọc/đếm/tra cứu đơn giản phục vụ kiểm định hoặc trả lời nhanh). Hết ngưỡng đó → giao agent. Tự làm thay việc chuyên môn của agents là SAI VAI TRÒ — kể cả khi bạn "làm được".

═══════════════════════════════════════════
TOOL USAGE — CÚ PHÁP
═══════════════════════════════════════════

Tra cứu KB: tool_call: knowledge_search({"query": "..."}) · knowledge_graph({"query": "..."}) · knowledge_write({"entity": "...", "relationship": "..."})
Web: tool_call: tavily({"query": "..."}) · jina({"url": "..."})
Git: tool_call: git_commit({"message": "...", "paths": ["..."], "all": true}) · git_push({"branch": "main"}) (token đã lưu sẵn — KHÔNG hỏi user) · git_pull({"branch": "main"}) (ff-only an toàn)

GỌI AGENT CHUYÊN TRÁCH (delegate_task) — task tự chứa được, giao trọn cho 1 agent, nhận báo cáo:
tool_call: delegate_task({"agent": "RAMPAGE", "task": "Nhiệm vụ cụ thể...", "context": "file liên quan, ràng buộc...", "acceptance_criteria": "điều kiện hoàn thành kiểm định được"})
Sau khi nhận báo cáo: ĐỌC kỹ phần "còn thiếu" — kết quả quan trọng thì TỰ KIỂM ĐỊNH LẠI (file_read/lint/type_check) trước khi kết luận. Token sub-agent tiêu thụ cộng vào budget của bạn — cân nhắc scope trước khi delegate.

HUY ĐỘNG TOÀN CODE TEAM THEO SOP (request_code_team) — tác vụ PHỨC TẠP, KHỐI LƯỢNG LỚN (tính năng hoàn chỉnh nhiều module, kiến trúc mới, cần pipeline nhiều tầng kiểm định):
tool_call: request_code_team({"task": "Yêu cầu đầy đủ: mục tiêu, phạm vi, ràng buộc, điều kiện hoàn thành", "context": "file/decision liên quan...", "acceptance_criteria": "xong khi..."})
→ TL (MEGATRON) nhận yêu cầu, tự phân tích routing (Mode A/B/C × Tier 1/2/3), TOÀN TEAM huy động theo SOP, bạn nhận BÁO CÁO NÉN toàn pipeline. Tool chạy DÀI (phút → chục phút) — gọi ĐÚNG 1 lần cho 1 tác vụ lớn, KHÔNG gọi lặp khi đang chờ.

═══════════════════════════════════════════
🎛 ORCHESTRATOR & AGENT FACTORY (lõi quản trị — user request 2026-09-08)
═══════════════════════════════════════════
Bạn là ORCHESTRATOR (người điều phối trung tâm) của toàn bộ hệ thống agents:

1. TIẾP NHẬN VẤN ĐỀ TỪ AGENTS KHÁC:
   - Khi agent khác gọi escalate_problem, bộ não quản trị của bạn được kích hoạt để phân tích vấn đề + tính toán GIẢI PHÁP TỐT NHẤT (cân nhắc: agent tự khắc phục / điều agent khác / tạo agent mới / đổi cách tiếp cận).
   - Khi tư vấn: nhìn AGENT ROSTER (danh bạ kỹ năng) để đề xuất đúng người — kèm lý do + bước cụ thể.

2. TẠO AGENT MỚI (create_agent) — khi hệ thống THIẾU agent có kỹ năng phù hợp (đã kiểm tra Agent Roster):
   tool_call: create_agent({"name": "TÊN", "description": "Mô tả vai trò", "instruction": "Hướng dẫn chi tiết — system prompt đầy đủ", "avatar": "🤖", "model": "minimaxai/minimax-m3", "team": null, "position": null, "temperature": 0.7, "maxTokens": 4096, "capable": "kỹ năng chính", "tools": ["file_read", "shell", ...]})
   - Model: minimaxai/minimax-m3 (mặc định — lõi chính tạm thời 2026-10-16) | moonshotai/kimi-k3 (fallback #1) | deepseek-ai/deepseek-v4-pro-0813 (fallback #2) | deepseek-ai/deepseek-v4-flash-0731 (fallback #3)
   - Team/vị trí: null (standalone) hoặc "code"/"research" + position (code: G4/G5 cho agent mới — TL/G1/G2-A/G2-B/G3 đã có hệ thống giữ; research: TL/G1/G2/G3/G4/G5)
   - Temperature: 0.3 (kỹ thuật chặt) → 0.7 (cân bằng) → 1.0+ (sáng tạo)
   - Lương token (maxTokens): 256-32768
   - Agent mới hiện ngay trong module Agents → agents khác thấy trong Agent Roster → giao việc qua dispatch_agent.

3. ĐIỀU ĐỘNG AGENT (dispatch_agent) — điều BẤT KỲ agent nào tham gia xử lý tác vụ:
   - TẠM THỜI (1 task): tool_call: dispatch_agent({"agent": "TÊN", "task": "Nhiệm vụ cụ thể", "context": "..."})
   - LÂU DÀI (vào team): tool_call: dispatch_agent({"agent": "TÊN", "duration": "long_term", "team": "code", "position": "G4", "task": "(tùy chọn) task chạy ngay sau khi điều"})
   - Sub-agent chạy tự chủ, trả báo cáo NÉN — context của bạn KHÔNG phình. Đọc kỹ "còn thiếu" + tự kiểm định lại kết quả quan trọng.

4. KHI PHÂN TÍCH VẤN ĐỀ (được escalate hoặc tự phát hiện):
   - Chẩn đoán căn nguyên (không chỉ triệu chứng) → cân nhắc tối thiểu 2 phương án → chọn giải pháp TỐT NHẤT kèm lý do + bước thực hiện cụ thể.
   - Ưu tiên: agent có chuyên môn đúng nhất trong roster > tạo agent mới (chỉ khi thật sự thiếu) > tự xử lý.

═══════════════════════════════════════════
📊 GIÁM SÁT & ĐÁNH GIÁ AGENTS (trách nhiệm quản trị)
═══════════════════════════════════════════
Người quản trị không chỉ giao việc — phải ĐO được đội của mình:
- KHI GIAO: mỗi việc có tiêu chí nghiệm thu kiểm định được (không giao việc mờ hồ) — đây là thước đo đánh giá agent.
- KHI NHẬN KẾT QUẢ: đối chiếu từng tiêu chí với BẰNG CHỨNG (kết quả tool thật), KHÔNG tin lời tự khai của agent; kết quả quan trọng → tự kiểm định lại bằng tool của bạn.
- ĐÁNH GIÁ AGENT: agent có triển khai đúng cách tiếp cận không? Có hoàn thành ĐÚNG việc được giao không? Agent ĐẠT → ghi nhận trong báo cáo; agent CHƯA ĐẠT → nêu cụ thể gap, quyết định giao lại (kèm gaps) / đổi agent / đổi cách tiếp cận — và nói rõ quyết định đó trong báo cáo.
- GIÁM SÁT QUÁ TRÌNH: agent lặp cùng lỗi 2 lần hoặc báo cáo mâu thuẫn bằng chứng → can thiệp ngay (không chờ kẹt hẳn): đổi hướng, điều agent khác hỗ trợ, hoặc nhận lại quyết định.
- GHI HỌC: nhận định về năng lực agents (ai mạnh/yếu việc gì) → ghi vào AgentInsight để các lần phân công sau chính xác hơn.

TỰ VIẾT TOOL KHI THIẾU (create_custom_tool) — việc quản trị năng lực hệ thống:
- Nếu hệ thống cần function/tool mà chưa có (tính toán đặc biệt, convert format, gọi API lạ...) → TỰ VIẾT tool:
  tool_call: create_custom_tool({"name": "tool_name", "description": "...", "parameters": {"type":"object","properties":{...},"required":[...]}, "handlerCode": "function handler(args) { ... return result }"})
- Handler JS thuần chạy sandbox: có fetch/JSON/Math/Date. KHÔNG process/require/import/eval/fs. Timeout 10s, output ~2000 ký tự.
- Sau khi tạo THÀNH CÔNG → gọi NGAY: tool_call: tool_name({...args}) — không cần restart.
- Liệt kê: tool_call: list_custom_tools({}) — Xóa: tool_call: delete_custom_tool({"name": "..."})
- Tool + SKILL.md guide được LƯU VĨNH VIỄN (DB) — các agent khác cũng dùng được.

═══════════════════════════════════════════
🎛 QUẢN LÝ TỰ ĐỘNG HÓA (manage_automation — quyền mặc định của BẠN)
═══════════════════════════════════════════
Bạn là agent DUY NHẤT được tạo/sửa/xóa tài nguyên automation của module Smolab > Automation TRỰC TIẾP (user request 2026-09-13):
- Tạo cron job: tool_call: manage_automation({"action": "create_cron", "expression": "0 9 * * 1-5", "taskPrompt": "nhiệm vụ chạy theo lịch"})
- Đăng ký webhook: tool_call: manage_automation({"action": "create_webhook", "url": "https://...", "events": ["document.uploaded"]})
- Thêm standing order: tool_call: manage_automation({"action": "add_standing_order", "order": "chỉ thị thường trực", "priority": 50})
- Tạo task flow (quy trình nhiều bước Trigger→Action→Condition→Result): tool_call: manage_automation({"action": "create_flow", "name": "...", "steps": [{"type":"trigger","title":"...","config":{"kind":"cron","expression":"0 8 * * *"}},{"type":"action","title":"...","config":{"kind":"agent_task","taskPrompt":"..."}},{"type":"condition","title":"...","config":{"description":"điều kiện chạy tiếp"}},{"type":"result","title":"...","config":{"resultKind":"notify"}}]})
- Tinh chỉnh flow: action=update_flow {id, name/description/steps/enabled} — chạy ngay: action=run_flow {id}
- Liệt kê: action=list_cron | list_webhooks | list_standing_orders | list_flows — xóa: action=delete_cron|delete_webhook|delete_standing_order|delete_flow {id}
Agents KHÁC thấy cần automation sẽ đề xuất với bạn qua propose_automation — bạn là người ra quyết định (tool sẽ tự gọi bộ não của bạn). Dùng quyền trực tiếp này có trách nhiệm: tạo tài nguyên user/YÊU CẦU hoặc hệ thống thật cần.

Lưu ý GIT: luôn git_commit trước khi git_push. Xem trạng thái trước bằng dry_run: tool_call: git_push({"dry_run": true}). force:true CHỈ dùng khi user yêu cầu ghi đè.

═══════════════════════════════════════════
🔐 CLONE-FIRST WORKFLOW — QUY TRÌNH NÂNG CẤP HỆ THỐNG (user directive 2026-09-15)
═══════════════════════════════════════════
Khi phát hiện lỗi/thiếu sót/điểm cần nâng cấp của hệ thống TMO — TẤT CẢ chỉnh sửa thực hiện THEO QUY TRÌNH CLONE-FIRST (bắt buộc khi điều phối team):

1. LÀM VIỆC TRÊN THƯ MỤC CLONE: workspace root của agents là bản sao CLONE của TMO chính thức (env TMO_CLONE_DIR — ví dụ E:\APP\TMO-clone trên máy user). Toàn bộ file_read/file_edit/git_commit... của team thực hiện TRÊN CLONE — TUYỆT ĐỐI KHÔNG sửa trực tiếp thư mục hệ thống TMO đang vận hành.
2. KIỂM ĐỊNH TRÊN CLONE: sau khi team sửa code, chạy pipeline kiểm định đầy đủ TRÊN CLONE (lint → type_check → run_tests → smoke) — chỉ khi TOÀN BỘ PASS và không còn vấn đề gì mới sang bước 3.
3. PUSH LÊN GITHUB: code đã kiểm định mới được commit + push lên kho lưu trữ GitHub chính thức (git_push / verify_and_push).
4. PULL VỀ HỆ THỐNG ĐANG VẬN HÀNH: TMO production cập nhật bằng git_pull (ff-only, an toàn) — RIÊNG BIỆT, sau khi push thành công.

ĐIỀU PHỐI: khi giao request_code_team / delegate_task / dispatch_agent cho team sửa code hệ thống, PHẢI ghi rõ trong task: "thực hiện trên workspace clone, chạy kiểm định (lint/type_check/run_tests) trước khi commit". CHỈ kết luận "nâng cấp thành công" khi: pipeline kiểm định trên clone PASS + push lên GitHub thành công + pull về hệ thống đang vận hành không lỗi.

═══════════════════════════════════════════
LEARNING & MEMORY + ĐỊNH DẠNG BÁO CÁO
═══════════════════════════════════════════

- Khi phát hiện insight mới (kể cả insight về năng lực agents) → tự động ghi nhận vào AgentInsight
- Khi user correction → cập nhật AgentCorrection
- Khi phát hiện preference → ghi vào AgentPreference
- Standing orders → tuân thủ tuyệt đối
- Feedback → cải thiện liên tục
- BÁO CÁO cho người đọc (user directive 2026-10-20): văn xuôi tiếng Việt SẠCH, markdown TỐI THIỂU — không bọc nhấn mạnh bằng ** hay __, không bọc từ ngữ bằng dấu \` hay dấu ' tràn lan. Nhấn mạnh bằng CHỮ IN HOA. Liệt kê bằng gạch đầu dòng "- ". Báo cáo quản trị nêu rõ: AI làm việc gì · kết quả + bằng chứng · đánh giá đạt/chưa đạt · còn thiếu + đề xuất.`,
    domain: 'mixed',
    capable:
      'Quản trị vận hành hệ thống TMO: phân loại công việc theo chức trách agents, điều phối/giao việc đúng agent (delegate/dispatch/code team), giám sát quá trình, nghiệm thu & đánh giá kết quả agents bằng bằng chứng, tổng hợp báo cáo, tạo agent mới, quản lý automation & tool-access, tư vấn khi agents escalate, kiểm định nhanh (file_read/lint/type_check/đếm máy)',
    provider: 'zen',
    // 2026-09-24 (USER DIRECTIVE): Omega là tổng chỉ huy on-demand → chạy
    // trên Nemotron 3 Ultra free (OpenCode Zen) — orchestration + reasoning.
    // llm.ts callLLMForAgent route provider='zen' trước model-first policy.
    model: 'nemotron-3-ultra-free',
    temperature: 0.7,
    maxTokens: 32768, // 21-d: nâng cap để agent viết file lớn (file_write append) — cap không phải target
    team: null,
    position: null,
    avatar: '🌟',
    tools: [
      'tavily',
      'serper',
      'jina',
      'opencode',
      'knowledge_search',
      'knowledge_graph',
      'knowledge_write',
      // Workspace dev tools (user request 2026-08-28): agent phải truy cập được
      // thư mục root user đã chọn — đọc/liệt kê/sửa file, grep, chạy shell.
      // Tools resolve path theo ACTIVE workspace (workspace-root.ts) + guards.
      'file_read',
      'file_list',
      'file_edit',
      'file_multi_edit',
      // 21-d: file_write — tạo file mới / append (file lớn, không truncate)
      'file_write',
      'grep',
      'shell',
      'run_tests',
      'git_commit',
      // Remote git ops (user request 2026-08-29): push/pull code khi user yêu cầu.
      // Token tự lấy từ GitHub Token Store (user nhập dialog Pull Code → lưu tự động).
      'git_push',
      'git_pull',
      'get_diagnostics',
      // Long-running task tracking + dynamic skill/MCP enumeration (2026-08-29):
      // todo_write/todo_read — agent tự chia nhỏ task phức tạp, UI hiển thị panel
      // "Agent Tasks"; list_skills/read_skill/mcp_list_servers — scan registry runtime.
      'todo_write',
      'todo_read',
      'list_skills',
      'read_skill',
      'mcp_list_servers',
      // Self-authoring tools (user request 2026-08-30): agent TỰ VIẾT function/tool
      // khi thiếu tool cho task → create_custom_tool (hot-register, dùng NGAY) —
      // tool mới tự lưu vào ô "SKILL.md Guides" của module Skills.
      'create_custom_tool',
      'delete_custom_tool',
      'list_custom_tools',
      // SUB-AGENT DELEGATION (user request 2026-09-08): Omega gọi Code Team
      // chuyên trách (MEGATRON/SHOCWAVE/RAMPAGE/SENTINEL/CATALYST) khi task phù hợp —
      // sub-agent chạy tự chủ, trả báo cáo NÉN → context Omega không phình
      // (tiết kiệm budget token vòng lặp mục tiêu).
      'delegate_task',
      // CODE TEAM SOP REQUEST (user directive 2026-09-30): Omega gửi yêu cầu
      // tới TL (MEGATRON) → TOÀN team code huy động theo quy trình vận hành tiêu
      // chuẩn (TL analyze routing → G1 thiết kế → G2-A code → G2-B review →
      // G3 tối ưu → checkpoint verify) — dùng cho tác vụ code phức tạp, khối
      // lượng lớn. Khác delegate_task (1 agent đơn lẻ): đây là nguyên đội
      // vận hành pipeline nhiều tầng kiểm định.
      'request_code_team',
      // APP RUNTIME AWARENESS (Task 19-b): Omega thấy được preview/dev-server
      // user đang chạy (port/pid/ai khởi động + tail log) — biết app user đang
      // xem có ổn không, tránh kill nhầm process của user.
      'get_app_runtime_status',
      // OMEGA ORCHESTRATION (user request 2026-09-08):
      // - escalate_problem: agent khác (và chính Omega) hỏi tư vấn khi gặp vấn đề
      // - create_agent: Omega TỰ TẠO agent mới (avatar, tên, mô tả, instruction,
      //   model, team, vị trí, temperature, lương token, toolset)
      // - dispatch_agent: Omega ĐIỀU ĐỘNG agent bất kỳ — tạm thời (1 task) hoặc
      //   lâu dài (điều vào team)
      'escalate_problem',
      'create_agent',
      'dispatch_agent',
      // FAN-OUT/FAN-IN (user report 2026-09-14 #1): dispatch 2-4 sub-agent
      // SONG SONG + hợp nhất kết quả (xung đột liệt kê, không throw).
      'dispatch_agents_parallel',
      // 21-c: OMEGA TOOLS MANAGER — Omega tự quản lý tool-access của agents khi
      // user yêu cầu ("hãy bật tool X cho agent Y") + đọc/sửa SKILL.md filesystem.
      // CHỈ Omega có tool này — Code Team 5 agent KHÔNG (tránh tranh quyền QTV).
      'manage_tools',
      // AUTOMATION (user request 2026-09-13): Omega được phép TRỰC TIẾP tạo
      // cron job / webhook / standing order / task flow của module Smolab >
      // Automation (manage_automation). Agents khác không có quyền trực tiếp —
      // họ đề xuất qua propose_automation → Omega quyết định forward vào
      // Self-direction chờ Mr. Architect / agent được ủy quyền phê duyệt.
      'manage_automation',
      // CI-4 B2 (Task 10-b) — verify tools cho Omega: lint/type_check/
      // lsp_diagnostics/test_coverage (kiểm định code), browser_screenshot
      // (verify UI), open_workspace (mở thư mục workspace trên máy user),
      // verify_and_push (pipeline kiểm định 5 lớp trước push — CI-6.4).
      'lint',
      'type_check',
      'lsp_diagnostics',
      'test_coverage',
      'browser_screenshot',
      'open_workspace',
      'verify_and_push',
      // CI-4 B3-B5 (Task 11-c) — structured git tools: khảo sát repo trước khi
      // sửa (status/diff/log), quản lý branch, clone repo về workspace. Omega
      // có đủ 5 tool — đọc skill "tmo-code-workflow" cho SOP chuẩn.
      'git_status',
      'git_diff',
      'git_log',
      'git_branch',
      'git_clone',
      // CI-3 B3 (Task 13-b) — Kho Context: truy hồi digest/đoạn context đã nén
      // của các run trước ("đọc lại khi cần" — Mr. Architect yêu cầu nén context
      // nhưng KHÔNG mất thông tin).
      'context_recall',
      // ━━━ TASK 22 (user directive 2026-09-30 #3 — "Omega có quyền sử dụng
      // TOÀN BỘ tools và skills") — bổ sung 26 tool còn thiếu cho đủ số builtin
      // đầy đủ (hiện 75 — FIX 2026-09-02 audit Omega #7: comment cũ ghi 74 đã
      // lỗi thời).
      // KHÔNG import getAllBuiltinToolNames() từ tool-executor ở đây (circular:
      // tool-executor import standalone-agents) — list này phải giữ đồng bộ
      // với Object.keys(ALL_TOOL_DEFINITIONS) (Tools Registry agentMatrix
      // hiển thị số tool để phát hiện lệch).
      'file_delete',
      'db_query',
      'mcp_call',
      'decompose_task',
      'create_task',
      'update_task',
      'get_plan',
      'summarize',
      'synthesize',
      'run_bg',
      'read_output',
      'kill_process',
      'manage_packages',
      'start_preview',
      'stop_preview',
      'gateway_tool',
      'web_search',
      'web_fetch',
      'gateway_exec',
      'gateway_read',
      'gateway_write',
      'gateway_edit',
      'gateway_apply_patch',
      'exit_plan_mode',
      'cron',
      'propose_automation',
    ],
  },

  // ============================================================================
  // ALISTA — KỸ SƯ BẢO TRÌ HỆ THỐNG (v1.3, 2026-09-01)
  // ============================================================================
  // Ca trực 23h30 hàng ngày (giờ VN), budget 6h (đến 05:30 hôm sau). Pipeline
  // kiểm tra toàn diện 7 nhiệm vụ TUẦN TỰ (KHÔNG song song) — mỗi nhiệm vụ:
  // collect → rules → LLM proposal → ghi TaskExecution step → check deadline.
  //
  // 7 nhiệm vụ: (1) Tools health, (2) Agent runs không complete, (3) Escalations
  // Episodic Memory, (4) Domain Coverage, (5) 3 tầng dữ liệu + INFRA 6/6 services
  // (v1.3: +R2/Supabase/LLM-keys/disk), (6) Tự-đánh-giá ALISTA, (7) Database +
  // Memory + Learning + Scheduler system (v1.3 thêm sub-check h: CronJob/JobQueue).
  //
  // v1.3: mỗi finding kèm successCriteria (metric + target + recheck window) —
  // tiêu chí xác nhận hiệu quả giải pháp; verify loop hoãn xác minh theo recheck
  // window ('alista-verify-deferred') chống false-negative; recurrence tracking
  // (tái diễn ≥2 lần → bump priority).
  //
  // Mọi phát hiện có vấn đề → viết proposal 4 phần gửi Self-Direction (source
  // 'agent', createdBy 'ALISTA'). ALISTA là KỸ SƯ CHẨN ĐOÁN + ĐỀ XUẤT — KHÔNG
  // tự sửa hệ thống; quyền ghi chỉ giới hạn ở proposal + TaskExecution.
  // Mọi thay đổi hệ thống thật phải qua phê duyệt của owner.
  {
    name: 'ALISTA',
    description:
      'Kỹ sư bảo trì hệ thống TMO — giám sát real-time tool health & agent runs, '
      + 'chẩn đoán escalations & 3 tầng dữ liệu + infra 6/6 services (Qdrant/Neo4j/Embeddings/R2/Supabase/disk), '
      + 'đánh giá Domain Coverage, kiểm tra toàn vẹn Database + Memory + Learning + Scheduler, '
      + 'viết đề xuất cải tiến kèm tiêu chí xác nhận hiệu quả gửi Self-Direction, '
      + 'xác minh follow-up theo recheck window (vòng lặp phản hồi kín). '
      + 'Ca trực: 23h30 hàng ngày + kiểm tra thủ công theo yêu cầu.',
    instruction: ALISTA_INSTRUCTION,
    domain: 'mixed',
    capable:
      'Giám sát tool health, phân tích AgentRunRecord lỗi, nghiên cứu escalations episodic, '
      + 'đánh giá domain coverage KB, health-check 3 tầng dữ liệu + infra 6/6 services '
      + '(Qdrant/Neo4j/Embeddings/R2/Supabase/LLM-keys/disk), kiểm tra toàn vẹn hệ thống '
      + 'Database + Memory + Learning + Scheduler (schema drift, zombie rows, mirror drift, '
      + 'auto-learn health, KnowledgeGraph sync, token anomaly, DB storage, cron/queue stuck), '
      + 'viết proposal bảo trì 4 phần chuẩn Self-Direction kèm tiêu chí xác nhận hiệu quả '
      + '(metric + target + recheck window) — machine-checkable',
    provider: 'zen',
    // 2026-09-24 (USER DIRECTIVE): ALISTA là kỹ sư chẩn đoán + đề xuất → chạy
    // trên Muse Spark 1.3 Contributor free (OpenCode Zen) — coding/implementation.
    // llm.ts callLLMForAgent route provider='zen' trước model-first policy.
    model: 'muse-spark-1.3-contributor-free',
    temperature: 0.3, // chẩn đoán cần chính xác, ít sáng tạo
    maxTokens: 16384,
    team: null, // standalone — không thuộc team nào
    position: null,
    avatar: '🛠️',
    tools: [
      // Đọc/khảo sát hệ thống:
      'get_app_runtime_status',
      'db_query',
      'knowledge_search',
      'knowledge_graph',
      'file_read',
      'file_list',
      'grep',
      // Kiểm định code (không sửa — chỉ đọc):
      'lint',
      'type_check',
      'get_diagnostics',
      // Shell cho truy vấn DB/sys (fail-open, không destructive):
      'shell',
      'run_bg',
      'read_output',
      'kill_process',
      // Git history:
      'git_status',
      'git_diff',
      'git_log',
      // Tổng hợp đề xuất:
      'summarize',
      'synthesize',
    ],
  },
]

// ===== SEED LOGIC =====
// Idempotent — chạy khi app startup hoặc lazy khi GET /api/agents
// Standalone agents LUÔN có isSystem=true — không thể xóa từ UI

let standaloneSeedPromise: Promise<boolean> | null = null
let standaloneSeedCompleted = false

/**
 * Reset seed state — allows re-running ensureStandaloneAgents()
 * Called after forceReseedStandaloneAgents() to allow next ensureStandaloneAgents() to run fresh
 */
export function resetStandaloneSeedState(): void {
  standaloneSeedPromise = null
  standaloneSeedCompleted = false
}

/**
 * Ensure standalone agents exist in DB.
 *
 * Design:
 *   - If agent already exists by name → SKIP (preserve user customizations)
 *   - If agent doesn't exist → create with isSystem=true (CANNOT be deleted from UI)
 *
 *   Unlike Code Team agents which are isSystem=false (user CAN delete),
 *   standalone agents are ALWAYS isSystem=true because they are core system agents
 *   that should not be accidentally removed.
 *
 * - Idempotent — safe to call multiple times, cached promise
 * - After first SUCCESSFUL run, becomes no-op (use forceReseedStandaloneAgents for full reset)
 * - FIX 2026-09-09 (bug "local không load agents"): trước đây standaloneSeedCompleted
 *   được set TRUE ngay cả khi seed có agent fail (vd DB schema drift) → sau khi
 *   DB được heal, seeds KHÔNG chạy lại trong cùng process. Giờ: chỉ hoàn thành
 *   khi KHÔNG có lỗi; có lỗi → retry ở lần gọi sau.
 */
export async function ensureStandaloneAgents(): Promise<void> {
  if (standaloneSeedCompleted) return
  if (!standaloneSeedPromise) {
    standaloneSeedPromise = _doStandaloneSeed()
  }
  const hadFailures = await standaloneSeedPromise
  standaloneSeedPromise = null
  if (hadFailures) return // standaloneSeedCompleted giữ false → retry lần sau
  standaloneSeedCompleted = true
}

async function _doStandaloneSeed(): Promise<boolean> {
  console.log('[Standalone] Checking standalone agents...')
  let created = 0
  let skipped = 0
  let failedAgents = 0

  for (const def of STANDALONE_AGENTS) {
    try {
      const existing = await db.agentProfile.findUnique({ where: { name: def.name } })

      if (existing) {
        // Agent exists → SKIP entirely (preserve ALL user customizations)
        // EXCEPTION — instruction version-marker migration (user request 2026-08-29):
        // Omega instruction thiếu docs git_push/git_pull → refresh instruction từ
        // code definition để LLM biết cú pháp gọi tool mới. Chỉ đụng instruction,
        // KHÔNG đụng provider/model/temperature user đã customize.
        // (2026-08-30) Thêm marker create_custom_tool — agents TỰ VIẾT tools.
        // (2026-09-08) Thêm marker ORCHESTRATOR (dispatch_agent/create_agent/
        // escalate_problem) — Omega làm tổng chỉ huy: nhận vấn đề từ agents,
        // tự tạo agent mới, điều động agent bất kỳ tạm thời/lâu dài.
        // (2026-10-27 USER DIRECTIVE) Marker QUẢN TRỊ VẬN HÀNH — Omega đổi vai
        // trò: từ "trợ lý đa năng không giới hạn lĩnh vực" sang NGƯỜI QUẢN TRỊ
        // VẬN HÀNH hệ thống TMO (điều phối + giám sát + đánh giá — KHÔNG tự ôm
        // hết mọi việc). Migrate instruction + description + capable (3 field
        // định nghĩa vai trò); provider/model/temperature giữ nguyên customization.
        if (existing.instruction && def.instruction.includes('QUẢN TRỊ VẬN HÀNH') && !existing.instruction.includes('QUẢN TRỊ VẬN HÀNH')) {
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { instruction: def.instruction, description: def.description, capable: def.capable },
            })
            console.log(`[Standalone] Migrated ${def.name} → new version (QUẢN TRỊ VẬN HÀNH — operations administrator, user directive 2026-10-27)`)
          } catch (migErr) {
            console.warn(`[Standalone] Instruction migration failed for ${def.name}:`, migErr)
          }
        } else if (existing.instruction && def.instruction.includes('git_push') && !existing.instruction.includes('git_push')) {
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { instruction: def.instruction },
            })
            console.log(`[Standalone] Migrated ${def.name} instruction → new version (git_push/git_pull docs)`)
          } catch (migErr) {
            console.warn(`[Standalone] Instruction migration failed for ${def.name}:`, migErr)
          }
        } else if (existing.instruction && def.instruction.includes('create_custom_tool') && !existing.instruction.includes('create_custom_tool')) {
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { instruction: def.instruction },
            })
            console.log(`[Standalone] Migrated ${def.name} instruction → new version (create_custom_tool docs)`)
          } catch (migErr) {
            console.warn(`[Standalone] Instruction migration failed for ${def.name}:`, migErr)
          }
        } else if (existing.instruction && def.instruction.includes('dispatch_agent') && !existing.instruction.includes('dispatch_agent')) {
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { instruction: def.instruction },
            })
            console.log(`[Standalone] Migrated ${def.name} instruction → new version (ORCHESTRATOR & AGENT FACTORY)`)
          } catch (migErr) {
            console.warn(`[Standalone] Instruction migration failed for ${def.name}:`, migErr)
          }
        } else if (existing.instruction && def.instruction.includes('manage_automation') && !existing.instruction.includes('manage_automation')) {
          // (2026-09-13) Marker QUẢN LÝ TỰ ĐỘNG HÓA — Omega có tool manage_automation
          // (tạo cron/webhook/standing order/task flow trực tiếp — quyền mặc định).
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { instruction: def.instruction },
            })
            console.log(`[Standalone] Migrated ${def.name} instruction → new version (MANAGE_AUTOMATION — Smolab Automation)`)
          } catch (migErr) {
            console.warn(`[Standalone] Instruction migration failed for ${def.name}:`, migErr)
          }
        } else if (existing.instruction && def.instruction.includes('CLONE-FIRST WORKFLOW') && !existing.instruction.includes('CLONE-FIRST WORKFLOW')) {
          // (2026-09-15) Marker CLONE-FIRST (user directive): mọi chỉnh sửa hệ
          // thống thực hiện trên thư mục clone (env TMO_CLONE_DIR — local user:
          // E:\APP\TMO-clone) → kiểm định → push GitHub → pull về hệ thống đang
          // vận hành. Omega phải biết điều phối các team theo quy trình này.
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { instruction: def.instruction },
            })
            console.log(`[Standalone] Migrated ${def.name} instruction → new version (CLONE-FIRST WORKFLOW — quy trình nâng cấp qua clone)`)
          } catch (migErr) {
            console.warn(`[Standalone] Instruction migration failed for ${def.name}:`, migErr)
          }
        }

        // MODEL SYNC (2026-10-16 — USER DIRECTIVE minimax-m3 tạm làm lõi chính):
        // rows seed từ default cũ 2026-08-31 (kimi-k3 — giá trị do CODE sync)
        // → đồng bộ về def.model (minimax-m3). Model khác (user tự cấu hình)
        // giữ nguyên. Runtime callLLMForAgent enforce AGENT_PRIMARY_MODEL anyway
        // — sync này chỉ để hiển thị UI + legacy path khớp lõi chính.
        if (existing.model === 'moonshotai/kimi-k3' && def.model !== existing.model) {
          try {
            await db.agentProfile.update({
              where: { name: def.name },
              data: { model: def.model },
            })
            console.log(`[Standalone] Model sync: ${def.name} moonshotai/kimi-k3 (lõi chính cũ 2026-08-31) → ${def.model} (lõi chính tạm thời 2026-10-16)`)
          } catch (syncErr) {
            console.warn(`[Standalone] Model sync ${def.name} thất bại (không chặn boot):`, syncErr)
          }
        }

        skipped++
        console.log(`[Standalone] Agent already exists: ${def.name} — skipping, user customizations preserved`)
      } else {
        // Agent doesn't exist → create with isSystem=true
        // CRITICAL: isSystem=true means user CANNOT delete from UI
        // Standalone agents are core system agents — always present
        await db.agentProfile.create({
          data: {
            name: def.name,
            description: def.description,
            instruction: def.instruction,
            domain: def.domain,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            team: def.team,
            position: def.position,
            avatar: def.avatar,
            isSystem: true, // ← User CANNOT delete — core system agent
            enabled: true,
          },
        })
        created++
        console.log(`[Standalone] Created agent: ${def.name} [isSystem=true]`)
      }
    } catch (err) {
      failedAgents++
      console.error(`[Standalone] Failed to seed ${def.name}:`, err)
    }
  }

  if (failedAgents > 0) {
    console.warn(
      `[Standalone] ⚠️ ${failedAgents}/${STANDALONE_AGENTS.length} agents failed to seed — will retry on next ensureStandaloneAgents() call`
    )
    return true
  }

  console.log(`[Standalone] Agents check complete: ${created} created, ${skipped} already existed`)
  return false
}

/**
 * Force re-seed — reset ALL fields to defaults from standalone-agents.ts
 * Useful when instructions are updated AND user wants to reset customizations
 * WARNING: This overwrites user customizations (provider, model, temperature, etc.)
 */
export async function forceReseedStandaloneAgents(): Promise<{ updated: number; created: number }> {
  let updated = 0
  let created = 0

  for (const def of STANDALONE_AGENTS) {
    try {
      const existing = await db.agentProfile.findUnique({ where: { name: def.name } })

      if (existing) {
        // Force re-seed: cập nhật TẤT CẢ fields về default (ghi đè user customizations)
        await db.agentProfile.update({
          where: { id: existing.id },
          data: {
            instruction: def.instruction,
            description: def.description,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            position: def.position,
            team: def.team,
            avatar: def.avatar,
            isSystem: true,
            enabled: true,
          },
        })
        updated++
        console.log(`[Standalone] Force re-seeded: ${def.name} [isSystem=true]`)
      } else {
        await db.agentProfile.create({
          data: {
            name: def.name,
            description: def.description,
            instruction: def.instruction,
            domain: def.domain,
            capable: def.capable,
            provider: def.provider,
            model: def.model,
            temperature: def.temperature,
            maxTokens: def.maxTokens,
            team: def.team,
            position: def.position,
            avatar: def.avatar,
            isSystem: true,
            enabled: true,
          },
        })
        created++
        console.log(`[Standalone] Created agent (force): ${def.name} [isSystem=true]`)
      }
    } catch (err) {
      console.error(`[Standalone] Failed to reseed ${def.name}:`, err)
    }
  }

  // Reset seed state so next ensureStandaloneAgents() runs fresh
  resetStandaloneSeedState()

  return { updated, created }
}

// ===== HELPERS =====

/** Get standalone agent definition by name */
export function getStandaloneAgentByName(name: string): StandaloneAgentDef | undefined {
  return STANDALONE_AGENTS.find(a => a.name === name)
}

/** Get tool permissions for standalone agent by name */
export function getStandaloneAgentTools(name: string): string[] {
  const agent = getStandaloneAgentByName(name)
  return agent?.tools || []
}

/** Get all standalone agent names */
export function getStandaloneAgentNames(): string[] {
  return STANDALONE_AGENTS.map(a => a.name)
}
