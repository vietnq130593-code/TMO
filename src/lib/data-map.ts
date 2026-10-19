/**
 * r67 (AUDIT LƯỢT 9 — user chỉ đạo "DB là bộ não cần bản đồ"): BẢN ĐỒ DỮ LIỆU
 * HARDCODE của hệ thống TMO — nguồn sự thật DUY NHẤT về "dữ liệu nằm ở đâu,
 * đọc bằng tool nào, ghi bằng đường nào".
 *
 * Bối cảnh user (trích nguyên văn): "hệ thống không có LlamaIndex vậy lấy gì
 * làm bản đồ để các agent khi xử lý tác vụ biết công việc có liên quan đến
 * vùng database nào để truy vấn, làm sao biết phần công việc, triển khai,
 * vấn đề này nên được ghi vào vùng dữ liệu nào, và hệ thống không chỉ sử dụng
 * Qdrant mà còn dùng cả Neo4J".
 *
 * Thiết kế — HARDCODE chứ KHÔNG PHẢI prompt-dạy (user: "tôi không thích dạy
 * agents bằng prompt... mọi thứ với hệ thống TMO đều phải là hardcode"):
 *   1. DATA_REGIONS: registry tĩnh mọi vùng dữ liệu THẬT của hệ thống —
 *      Prisma/SQLite (~95 model dùng chính), Qdrant (3 collection), Neo4J
 *      (graph tri thức + episodic), file agent-runs/*.jsonl. Mỗi vùng ghi rõ:
 *      đọc bằng tool nào / ghi bằng đường nào / khi nào đọc / khi nào ghi.
 *   2. routeDataMap(query): bộ định tuyến DETERMINISTIC (keyword scoring —
 *      không LLM, không prompt) từ nội dung tác vụ → các vùng liên quan.
 *   3. buildDataMapBlock(query): harness goal-loop TỰ nạp khối bản đồ vào
 *      context đầu MỖI run mới (code-enforced — agents không cần nhớ phải hỏi;
 *      với dữ liệu lớn prompt-dạy dễ bị bỏ qua, đây là đường cứng).
 *   4. Tool `data_map`: agents tra cứu bản đồ theo nhu cầu (đăng ký trong
 *      tool-executor; whitelist của mọi agent mặc định vì read-only + rẻ).
 *
 * Vùng dữ liệu ở đây PHẢI khớp thực tế vận hành — vị trí lưu trữ, tên
 * collection Qdrant, nhãn node Neo4J được đối chiếu từ: prisma/schema.prisma,
 * src/lib/qdrant.ts, src/lib/neo4j.ts, src/lib/agent-memory.ts,
 * src/lib/episodic-memory/*, src/lib/kb-routing/*, agent-runs/*.jsonl.
 */

/** Kho lưu trữ vật lý của một vùng dữ liệu. */
export type DataStoreKind = 'prisma' | 'qdrant' | 'neo4j' | 'file'

export interface DataRegionDef {
  /** id ổn định — dùng làm khoá tham chiếu nội bộ */
  id: string
  store: DataStoreKind
  /** Vị trí vật lý chính xác (model Prisma / collection Qdrant / nhãn Neo4J) */
  location: string
  /** Vùng này chứa CÁI GÌ (tiếng Việt, ngắn gọn cho agent đọc) */
  purpose: string
  /** Tool/đường ĐỌC chính mà agent dùng được */
  readPath: string
  /** Tool/đường GHI chính */
  writePath: string
  /** Khi nào agent cần ĐỌC vùng này */
  readWhen: string
  /** Khi nào dữ liệu được GHI vào vùng này */
  writeWhen: string
  /**
   * Từ khoá định tuyến (tiếng Việt + tiếng Anh thường gặp). Bộ định tuyến
   * deterministic quét các từ khoá này trong văn bản mục tiêu/tác vụ.
   */
  keywords: string[]
}

/**
 * REGISTRY — mọi vùng dữ liệu vận hành của TMO. THỨ TỰ không quan trọng
 * (bộ định tuyến chấm điểm theo keyword); số lượng vùng giữ ~16 để khối nạp
 * đầu run nằm gọn trong ngân sách context.
 */
export const DATA_REGIONS: DataRegionDef[] = [
  {
    id: 'todo_plan',
    store: 'prisma',
    location: 'SQLite · Prisma model Todo (db/custom.db)',
    purpose: 'Kế hoạch công việc theo phiên/run: trạng thái todo pending/in_progress/completed/failed, cây cha-con (parentId), scope theo runId',
    readPath: 'tool todo_read (sessionId+runId tự ép đúng scope)',
    writePath: 'tool todo_write (mở/đóng/ghi todo — harness tự nạp lại GĐ2 kế tiếp)',
    readWhen: 'Đầu mỗi chu kỳ muốn biết việc dở/ven còn treo; trước khi khai báo xong việc phải đối chiếu todo id',
    writeWhen: 'Mỗi khi lập kế hoạch, bắt đầu làm 1 việc (in_progress), hoặc đóng việc khi có bằng chứng hoàn thành',
    keywords: ['todo', 'kế hoạch', 'lập kế', 'nhiệm vụ', 'việc cần làm', 'danh sách việc', 'checklist', 'trạng thái việc', 'phân công việc', 'plan', 'task list', 'bước làm'],
  },
  {
    id: 'agent_memory_warm',
    store: 'qdrant',
    location: 'Qdrant collection agent_memory (vector) + Prisma AgentMemory (payload gốc)',
    purpose: 'Trí nhớ dài hạn THEO TỪNG AGENT: insight/bài học/kết quả các run trước, xếp độ liên quan ngữ nghĩa',
    readPath: 'HARNESS TỰ NẠP đầu mỗi run mới (khối 🧠 TRÍ NHỚ DÀI HẠN trong context) + tool lessons_search({query}) tra cứu on-demand giữa run (r71)',
    writePath: 'HARNESS TỰ GHI cuối mỗi run (storeMemory) — agent KHÔNG cần (và không thể) ghi tay',
    readWhen: 'Tự động — dùng làm nền để không lặp việc run trước đã làm',
    writeWhen: 'Tự động cuối run',
    keywords: ['trí nhớ', 'nhớ dài hạn', 'bài học', 'insight', 'kinh nghiệm', 'run trước', 'memory', 'kết quả trước'],
  },
  {
    id: 'knowledge_kb',
    store: 'qdrant',
    location: 'Qdrant: theopus_documents (payload) + theopus_chunks (vector 2048-dim embedding)',
    purpose: 'Tri thức tài liệu người dùng nạp vào hệ thống (KB): đoạn văn bản đã chia chunk + embedding cho tìm kiếm ngữ nghĩa',
    readPath: 'tool knowledge_search ({query}) — semantic + hybrid (BM25/MMR, kb-routing)',
    writePath: 'tool knowledge_write (MỌI agents thực thi — r71 bỏ gate chỉ-CATALYST) + pipeline ingestion (upload → process → entities → reconcile)',
    readWhen: 'Cần tra cứu nội dung tài liệu/tri thức đã nạp (khi làm việc liên quan kiến thức người dùng đã lưu)',
    writeWhen: 'Có tri thức/tài liệu mới cần đưa vào KB cho các run sau dùng lại',
    keywords: ['tri thức', 'kiến thức', 'tài liệu', 'knowledge', 'kb', 'văn bản nạp', 'tìm ngữ nghĩa', 'semantic', 'tìm kiếm tài liệu'],
  },
  {
    id: 'knowledge_graph',
    store: 'neo4j',
    location: 'Neo4J: node Document/Concept + quan hệ CONTAINS/RELATED (mirror Prisma LocalEntity/LocalRelationship)',
    purpose: 'Đồ thị tri thức: thực thể (entity/concept) + quan hệ giữa chúng — bản đồ liên kết thay vì chỉ tìm tương đồng',
    readPath: 'tool knowledge_graph ({query}) — duyệt node + quan hệ lân cận',
    writePath: 'tool knowledge_write (MỌI agents — r71) + ingestion/reconcile (entity-resolver chuẩn hoá thực thể trùng) + harness TỰ ghi DelegationLesson cuối mỗi delegation có tín hiệu đáng học (r71)',
    readWhen: 'Cần biết các thực thể LIÊN QUAN đến nhau thế nào (quan hệ thay vì tương đồng từ khoá)',
    writeWhen: 'Có thực thể/quan hệ mới cần ghi nhận vào đồ thị tri thức',
    keywords: ['đồ thị', 'graph', 'thực thể', 'entity', 'quan hệ', 'relationship', 'khái niệm', 'concept', 'liên kết', 'bản đồ tri thức', 'bài học', 'lesson', 'ghi kb'],
  },
  {
    id: 'episodic_memory',
    store: 'neo4j',
    location: 'Neo4J: Episode/Action/ErrorOccurrence/Lesson/Session + CONTAINS (mirror Prisma EpisodeRecord/LessonRecord)',
    purpose: 'Trí nhớ sự kiện theo DÒNG THỜI GIAN: run nào làm gì, gặp lỗi gì, học được bài học gì (episodic + preact retrieval)',
    readPath: 'HARNESS preact tự truy hồi đầu run (agent-brain); tool lessons_search({query}) tra cứu on-demand giữa run (r71); UI /api/episodic/* xem lại',
    writePath: 'Recorder TỰ GHI theo mốc run (episode/lesson) — agent không ghi tay',
    readWhen: 'Tự động — bối cảnh "chuyện gì đã xảy ra các run trước" theo thời gian',
    writeWhen: 'Tự động theo mốc run',
    keywords: ['hồi ức', 'sự kiện', 'episode', 'lesson', 'bài học episodic', 'lỗi gặp', 'error occurrence', 'dòng thời gian', 'chuyện đã xảy ra'],
  },
  {
    id: 'session_transcript',
    store: 'prisma',
    location: 'Prisma ChatMessage/AgentSession (db/custom.db) + file agent-runs/*.jsonl (sự kiện thought/tool từng run)',
    readPath: 'HARNESS tự nạp chatHistory + tóm tắt các tác vụ trước; cần tra sâu: đọc file jsonl qua tool shell',
    writePath: 'HARNESS tự ghi mọi thought/tool event (recordAgentThought/recordAgentRunTool)',
    purpose: 'Bản ghi hội thoại phiên + nhật ký từng bước suy nghĩ/hành động của mọi run (dấu vết kiểm chứng)',
    readWhen: 'Cần truy vết lại chính xác agent nào đã làm gì/suy nghĩ gì ở bước trước',
    writeWhen: 'Tự động mọi lúc',
    keywords: ['phiên', 'session', 'hội thoại', 'transcript', 'nhật ký', 'log', 'sự kiện run', 'dấu vết', 'jsonl', 'truy vết'],
  },
  {
    id: 'run_history',
    store: 'prisma',
    location: 'Prisma AgentRunRecord + RunContext/TaskContextArchive + GoalLoopJob checkpoint',
    purpose: 'Lịch sử các run: mục tiêu, kết cục, checkpoint durable-resume, bối cảnh tác vụ đã nén lưu trữ',
    readPath: 'HARNESS nạp tóm tắt (priorTaskSummaries) đầu run; tra cứu sâu qua shell/db_query',
    writePath: 'HARNESS tự ghi (startAgentRun/finish + checkpoint worker)',
    readWhen: 'Muốn biết các tác vụ trước trong PHIÊN đã làm tới đâu (tránh làm lại)',
    writeWhen: 'Tự động',
    keywords: ['lịch sử run', 'run trước', 'checkpoint', 'tác vụ trước', 'quá trình', 'run record', 'resume'],
  },
  {
    id: 'arbiter_verdicts',
    store: 'prisma',
    location: 'Prisma ArbiterVerdict (db/custom.db)',
    purpose: 'Phán quyết của trọng tài (evaluator) từng chu kỳ: complete/confidence/missing/sideIssues + nợ kỹ thuật debt',
    readPath: 'HARNESS nạp pendingDebt/regression đầu run; tra cứu qua shell/db_query',
    writePath: 'HARNESS tự ghi sau mỗi lần đánh giá',
    readWhen: 'Muốn biết trọng tài từng phán gì, việc nào bị coi chưa đạt',
    writeWhen: 'Tự động sau mỗi chu kỳ đánh giá',
    keywords: ['trọng tài', 'phán quyết', 'verdict', 'đánh giá', 'nghiệm thu', 'evaluator', 'chấm', 'chưa đạt'],
  },
  {
    id: 'research_kb',
    store: 'prisma',
    location: 'Prisma ResearchMission/ResearchTask/ResearchWorklog/ResearchKBEntry (kho ALISTA)',
    // EXECUTION-EFFICIENCY S1 — ghi chú chống kết luận sai "research_kb riêng"
    // (bằng chứng: Omega run_1792386145100_1 tưởng 6 entity của ALISTA nằm trong
    // "research_kb riêng" nên không tìm — thực tế mọi knowledge_write ghi KB chung)
    purpose: 'Kho nghiên cứu: nhiệm vụ nghiên cứu, kết quả khảo sát, tri thức nghiên cứu tích luỹ của team research (ALISTA). LƯU Ý: tri thức ghi qua knowledge_write KHÔNG nằm đây — nó ghi vào KB CHUNG (LocalEntity/Neo4j) và tìm lại bằng knowledge_search',
    readPath: 'Tools research của ALISTA (kb-store G3); agent khác nhờ ALISTA điều phối. KHÔNG dùng để truy hồi entity đã knowledge_write — dùng knowledge_search',
    writePath: 'Tools research (ALISTA ghi kết quả mission/task/worklog). Agent MUỐN ghi tri thức dùng knowledge_write (KB chung)',
    readWhen: 'Tác vụ cần khảo sát/tổng hợp tài liệu bên ngoài + tri thức nghiên cứu đã có',
    writeWhen: 'Có kết quả nghiên cứu/ khảo sát cần lưu làm nền cho lần sau',
    keywords: ['nghiên cứu', 'khảo sát', 'research', 'alista', 'tổng hợp tài liệu', 'mission nghiên cứu', 'điều tra'],
  },
  {
    id: 'agent_profiles',
    store: 'prisma',
    location: 'Prisma AgentProfile/AgentSkill/AgentInsight/LearningLog/AgentCorrection',
    purpose: 'Hồ sơ agent: mô tả, kỹ năng, whitelist tool, insight hiệu năng, bản đồ năng lực (agent-capabilities)',
    readPath: 'UI quản trị + shell/db_query; agent đối chiếu qua khối Agent Roster trong prompt',
    writePath: 'Auto-learn tự ghi; user/Omega quản trị qua UI/API',
    readWhen: 'Cần biết agent nào chuyên môn gì để ĐÚNG NGƯỜI việc (đối chiếu phân công)',
    writeWhen: 'Khi năng lực/kỹ năng agent thay đổi (auto-learn)',
    keywords: ['hồ sơ agent', 'năng lực', 'kỹ năng', 'agent profile', 'chuyên môn', 'roster', 'đội hình', 'ai làm gì'],
  },
  {
    id: 'metrics_tokens',
    store: 'prisma',
    location: 'Prisma DailyToken*/ToolMetric/ToolMetricDaily/AgentWorkData/tokensUsage',
    purpose: 'Số liệu vận hành: token tiêu hao theo ngày/provider/agent, metric hiệu năng tool, workload hằng ngày',
    readPath: 'tool get_diagnostics + tool db_query (SELECT read-only) + shell sqlite3',
    writePath: 'HARNESS tự ghi theo từng call/run',
    readWhen: 'Cần số liệu đo lường cụ thể (token, hiệu năng, tần suất) làm bằng chứng',
    writeWhen: 'Tự động',
    keywords: ['số liệu', 'token', 'đo lường', 'metrics', 'tiêu hao', 'hiệu năng', 'thống kê', 'workload', 'tần suất'],
  },
  {
    id: 'debt_ledger',
    store: 'prisma',
    location: 'Prisma IssueLedger + OpusReview (sổ nợ kỹ thuật + biên bản rà soát)',
    purpose: 'Sổ theo dõi vấn đề/nợ kỹ thuật: vấn đề phát hiện, quyết định xử lý (none/record/continue), trạng thái đóng/mở',
    readPath: 'shell/db_query (SELECT IssueLedger); Omega/TL đối chiếu khi ra quyết định nợ',
    writePath: 'Omega/TL ghi qua API close-issue-ledger khi quyết xử lý xong vấn đề',
    readWhen: 'Trước khi kết luận một vấn đề đã xử lý/chưa — đối chiếu sổ thay vì nhớ đoán',
    writeWhen: 'Khi phát hiện vấn đề mới cần theo dõi hoặc quyết xử lý xong',
    keywords: ['nợ kỹ thuật', 'debt', 'issue', 'sổ theo dõi', 'vấn đề treo', 'technical debt', 'ledger', 'bỏ sót'],
  },
  {
    id: 'working_memory',
    store: 'prisma',
    location: 'Prisma WorkingMemory (db/custom.db)',
    purpose: 'Nhật ký hoạt động NGẮN HẠN của agent trong phiên (recordWorkMemory) — lớp đệm trước khi nén/giải ngân',
    readPath: 'HARNESS dùng nội bộ (context compression); agent nhìn qua panel',
    writePath: 'HARNESS tự ghi mỗi thao tác',
    readWhen: 'Tự động (lớp nền context)',
    writeWhen: 'Tự động',
    keywords: ['hoạt động hiện tại', 'working memory', 'nhật ký ngắn', 'đang làm gì'],
  },
  {
    id: 'memory_archive',
    store: 'prisma',
    location: 'Prisma MemoryArchive + MemoryAccessLog (kho lưu trữ dài hạn)',
    purpose: 'Trí nhớ đã lưu trữ (archive) từ AgentMemory cũ + nhật ký truy nhập bộ nhớ (ai đọc gì khi nào)',
    readPath: 'recallMemories nối archive theo qdrantPointId (Step 5); UI /api/memory/archive',
    writePath: 'Tự động khi memory vượt chu kỳ sống (archive policy)',
    readWhen: 'Truy hồi insight cũ đã rời trạng thái WARM',
    writeWhen: 'Tự động',
    keywords: ['lưu trữ', 'archive', 'trí nhớ cũ', 'bộ nhớ dài hạn'],
  },
  {
    id: 'ops_infra',
    store: 'file',
    location: 'agent-runs/*.jsonl (FS) + PM2 + gateway :81 + mini-services + Caddy',
    purpose: 'Hạ tầng vận hành: log run jsonl, trạng thái PM2, gateway, dịch vụ phụ trợ — tra cứu bằng công cụ máy',
    readPath: 'tool shell (pm2 list, curl health) + tool get_app_runtime_status + đọc file jsonl',
    writePath: 'PM2/Caddy cấu hình vận hành — KHÔNG nằm trong phạm vi agent tự ghi',
    readWhen: 'Cần kiểm chứng hạ tầng đang sống/chết, đọc log hệ thống',
    writeWhen: 'Vận hành thủ công (ngoài phạm vi agent)',
    keywords: ['hạ tầng', 'pm2', 'gateway', 'log hệ thống', 'sức khoẻ hệ thống', 'health', 'vận hành', 'infra'],
  },
  {
    id: 'db_adhoc',
    store: 'prisma',
    location: 'SQLite db/custom.db — TOÀN BỘ model Prisma (~95 model)',
    purpose: 'Cửa tra cứu ad-hoc có kiểm soát: mọi bảng dữ liệu hệ thống qua SQL chỉ-đọc',
    readPath: 'tool db_query (SELECT read-only, LIMIT ép sẵn, chống injection) + shell sqlite3 read-only',
    writePath: 'KHÔNG ghi trực tiếp — ghi qua đúng tool nghiệp vụ (todo_write/knowledge_write/…)',
    readWhen: 'Cần đếm/liệt kê dữ liệu cụ thể không có tool riêng (vd đếm session, liệt kê cron)',
    writeWhen: '— (chỉ đọc; ghi qua tool nghiệp vụ tương ứng từng vùng ở trên)',
    keywords: ['sql', 'truy vấn', 'cơ sở dữ liệu', 'database', 'đếm', 'liệt kê', 'bảng dữ liệu', 'query'],
  },
]

// ============================================================================
// BỘ ĐỊNH TUYẾN DETERMINISTIC (HARDCODE — 0 LLM, 0 prompt)
// ============================================================================

/** Chuẩn hoá tiếng Việt: lowercase + bỏ dấu thanh, giữ ký tự chữ. */
function normalizeQuery(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // bỏ dấu
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Chấm điểm một vùng theo số keyword khớp trong văn bản truy vấn (đã chuẩn
 * hoá). Keyword cũng được chuẩn hoá cùng chiều. Khớp = chứa chuỗi con (tách
 * từ theo khoảng trắng của keyword — đủ chặn cho các từ ngắn).
 */
function scoreRegion(region: DataRegionDef, normQuery: string): number {
  let score = 0
  for (const kw of region.keywords) {
    const nk = normalizeQuery(kw)
    if (!nk) continue
    if (normQuery.includes(nk)) score += nk.includes(' ') ? 2 : 1 // cụm từ nặng hơn từ đơn
  }
  return score
}

export interface DataMapRoute {
  /** Các vùng nên ĐỌC cho tác vụ này (giảm dần theo điểm) */
  reads: Array<{ region: DataRegionDef; score: number }>
  /** Các vùng có thể cần GHI cho tác vụ này (giảm dần theo điểm) */
  writes: Array<{ region: DataRegionDef; score: number }>
}

/**
 * Định tuyến văn bản tác vụ → vùng dữ liệu liên quan. Deterministic thuần
 * (keyword scoring) — cùng input luôn ra cùng output, không phụ thuộc LLM.
 */
export function routeDataMap(query: string): DataMapRoute {
  const normQuery = normalizeQuery(query || '')
  if (!normQuery) return { reads: [], writes: [] }
  const scored = DATA_REGIONS.map(region => ({ region, score: scoreRegion(region, normQuery) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
  // Vùng harness TỰ đọc/ghi (agent không thao tác trực tiếp) không đưa vào
  // chỉ dẫn reads/writes cho agent — tránh nhiễu chỉ dẫn vô ích.
  const agentActionable = scored.filter(s =>
    !(s.region.readPath.startsWith('HARNESS') && s.region.writePath.startsWith('HARNESS')))
  const reads = agentActionable.slice(0, 4)
  const writes = agentActionable
    .filter(s => !s.region.writePath.startsWith('—') && !s.region.writePath.startsWith('KHÔNG'))
    .slice(0, 3)
  return { reads, writes }
}

/**
 * Khối bản đồ nạp vào context ĐẦU RUN MỚI (goal-loop tự chèn — code-enforced).
 * Chỉ liệt kê vùng LIÊN QUAN theo định tuyến từ mục tiêu + nội dung user message
 * (không đổ cả 16 vùng làm phình context). Cap ~1600 chars, cắt vùng phụ nếu vượt.
 */
export function buildDataMapBlock(query: string, maxChars = 1600): string {
  const { reads, writes } = routeDataMap(query)
  // r68 (BUG-015 — quan sát mission cmuznvkl…6b136k): directive mơ hồ
  // ("Tiếp tục triển khai…") score 0 trên toàn bộ 16 vùng → block RỖNG →
  // mission thật chạy KHÔNG bản đồ (0/18 message chứa 🗺️) — đúng những
  // mission tiếp nối khó nhất lại mất chỉ dẫn nhất. Fallback hardcode:
  // 0-match → LIỆT KÊ SƠ LƯỢC TOÀN BỘ registry (1 dòng/vùng) thay vì im
  // lặng — agent ít nhất biết các vùng tồn tại + gọi data_map khi cần.
  if (reads.length === 0 && writes.length === 0) {
    const lines = DATA_REGIONS.map(r => {
      const storeTag = r.store === 'qdrant' ? 'Qdrant' : r.store === 'neo4j' ? 'Neo4J' : r.store === 'file' ? 'File' : 'SQLite'
      return `- [${r.id}] (${storeTag}) ${r.purpose}`
    })
    return (
      `\n\n🗺️ BẢN ĐỒ DỮ LIỆU (mục tiêu này KHÔNG khớp vùng chuyên biệt nào theo từ khoá — nên liệt kê SƠ LƯỢC toàn bộ ${DATA_REGIONS.length} vùng; dùng tool data_map({query: "mô tả việc cụ thể"}) để định tuyến đúng vùng):\n` +
      lines.join('\n').slice(0, maxChars - 400) +
      `\nTra bản đồ đầy đủ bất cứ lúc nào: tool data_map({query: "mô tả việc"})`
    )
  }
  const fmtRegion = (r: DataRegionDef) => {
    const storeTag = r.store === 'qdrant' ? 'Qdrant' : r.store === 'neo4j' ? 'Neo4J' : r.store === 'file' ? 'File/Infra' : 'SQLite'
    return `- [${r.id}] (${storeTag}) ${r.purpose}\n  · Đọc: ${r.readPath}\n  · Ghi: ${r.writePath}`
  }
  let block =
    `\n\n🗺️ BẢN ĐỒ DỮ LIỆU liên quan mục tiêu này (harness định tuyến tự động — đọc/ghi ĐÚNG VÙNG, không đoán mò):\n`
  if (reads.length > 0) {
    block += `ĐỌC khi cần:\n${reads.map(x => fmtRegion(x.region)).join('\n')}\n`
  }
  if (writes.length > 0) {
    block += `GHI kết quả đúng vùng:\n${writes.map(x => fmtRegion(x.region)).join('\n')}\n`
  }
  block += `Tra bản đồ đầy đủ bất cứ lúc nào: tool data_map({query: "mô tả việc"})`
  if (block.length > maxChars) {
    // Cắt dần vùng phụ (giữ vùng điểm cao nhất) đến khi vừa ngân sách.
    // r71 (fix cap logic — test r67 bắt hồi quy): cách tính keep cũ KHÔNG
    // tái kiểm tra sau khi ghép lại — nhiều vùng khớp (nhờ keyword mới
    // 'bài học'/'lesson' ở knowledge_graph) vẫn vượt cap. Giờ: vòng cắt
    // THẬT SỰ giảm dần số vùng cho tới khi tổng ≤ maxChars — đảm bảo
    // hợp đồng "cap ~1600 chars" luôn đúng với MỌI tổ hợp khớp.
    const { reads: r2, writes: w2 } = routeDataMap(query)
    let keepR = r2.length
    let keepW = w2.length
    for (let guard = 0; guard < 20 && block.length > maxChars; guard++) {
      // Ưu tiên giữ read (nền để agent tra) — cắt write trước, rồi cắt read
      if (keepW > 1) keepW--
      else if (keepR > 1) keepR--
      else if (keepW > 0) keepW--
      else if (keepR > 0) keepR--
      else break
      block =
        `\n\n🗺️ BẢN ĐỒ DỮ LIỆU liên quan mục tiêu này (harness định tuyến tự động — đọc/ghi ĐÚNG VÙNG, không đoán mò):\n` +
        (keepR > 0 ? `ĐỌC khi cần:\n${r2.slice(0, keepR).map(x => fmtRegion(x.region)).join('\n')}\n` : '') +
        (keepW > 0 ? `GHI kết quả đúng vùng:\n${w2.slice(0, keepW).map(x => fmtRegion(x.region)).join('\n')}\n` : '') +
        `Tra bản đồ đầy đủ bất cứ lúc nào: tool data_map({query: "mô tả việc"})`
    }
  }
  return block
}

/** Kết quả cho tool data_map — toàn bộ bản đồ hoặc phần định tuyến theo query. */
export function dataMapToolResult(query?: string): Record<string, unknown> {
  if (!query || !query.trim()) {
    return {
      success: true,
      mode: 'full',
      regions: DATA_REGIONS.map(r => ({
        id: r.id,
        store: r.store,
        location: r.location,
        purpose: r.purpose,
        doc: r.readPath,
        ghi: r.writePath,
        khiNaoDoc: r.readWhen,
        khiNaoGhi: r.writeWhen,
      })),
      hint: 'Truyền {query: "mô tả việc"} để nhận đúng vùng liên quan (định tuyến tự động).',
    }
  }
  const { reads, writes } = routeDataMap(query)
  return {
    success: true,
    mode: 'routed',
    query,
    docKhiCan: reads.map(x => ({ id: x.region.id, store: x.region.store, location: x.region.location, docBang: x.region.readPath, vi: x.region.purpose })),
    ghiVao: writes.map(x => ({ id: x.region.id, store: x.region.store, location: x.region.location, ghiBang: x.region.writePath, vi: x.region.purpose })),
    hint: writes.length === 0 && reads.length === 0
      ? 'Không khớp vùng nào theo từ khoá — gọi lại không query để xem bản đồ đầy đủ.'
      : 'Đọc/ghi đúng vùng như trên — KHÔNG ghi tay vào vùng của harness (🧠/episodic tự động).',
  }
}
