/**
 * NEURAL-ARCHITECTURE TAB — ĐỊNH NGHĨA KIẾN TRÚC + THÔNG SỐ TINH CHỈNH
 * (tab "Kiến trúc Neural" của module Database — 2026-10-11)
 *
 * Module THUẦN DỮ LIỆU: KHÔNG import gì (kể cả @/lib/db) — an toàn cho cả
 * client bundle (UI chỉ import type) lẫn server (API phục nguyên vẹn qua
 * /api/neural-architecture). Mọi mô tả node/edge/tham số là ĐƠN NGUỒN SỰ
 * THẬT cho: đồ thị lớp (layer graph), inspector panel, bảng tinh chỉnh.
 *
 * Hai khối:
 *   1. TUNING_SPECS — 14 hyperparameter vận hành thực (đọc/ghi runtime qua
 *      tuning-store: STORE > ENV > DEFAULT) gắn với từng node.
 *   2. NEURAL_GRAPH — 6 lớp × 23 node × 37 cạnh: toàn bộ "mạng thần kinh"
 *      của TMO từ đầu vào (tài liệu/chat/workflow) qua xử lý (dedup/embed/
 *      entity-res/pre-act), lưu trữ (SQLite/Qdrant/Neo4j/R2), học (Q-table/
 *      adaptation/lessons/Wilson/IQR), quyết định (stats-gate/softmax/strategy)
 *      đến đầu ra (LLM/response/advisory) — kèm dòng chảy reward W1/W2 khép
 *      vòng học.
 */

// ==================== TYPES ====================

export type TuningType = 'number' | 'enum'

/** Nguồn giá trị hiệu lực của một tham số. */
export type TuningSource = 'store' | 'env' | 'default'

export interface TuningSpec {
  /** Định danh ổn định — trùng Prisma TuningParam.key (đổi key = mất giá trị user) */
  key: string
  /** Nhãn hiển thị (kèm ký hiệu toán học khi có) */
  label: string
  /** Mô tả 1-2 câu: tham số này chi phối cái gì */
  description: string
  /** Node đồ thị mà tham số này tinh chỉnh */
  nodeId: string
  type: TuningType
  /** type='number' bắt buộc có min/max; step cho slider */
  min?: number
  max?: number
  step?: number
  /** type='enum' bắt buộc có danh sách giá trị hợp lệ */
  enumValues?: readonly string[]
  /** Giá trị mặc định — trùng hằng số trong code nguồn */
  default: number | string
  /** Env fallback: có store-value thì thắng, không thì đọc env này theo envMap */
  envKey?: string
  /**
   * Chuẩn hoá chuỗi env thô → giá trị chuẩn (hoặc undefined = env không hợp
   * lệ → dùng default). Với type='number' có sẵn parse builtin (parseFloat +
   * clamp min/max) — envMap chỉ cần cho enum.
   */
  envMap?: (raw: string) => string | undefined
  /** Đơn vị hiển thị (vd 'ms') */
  unit?: string
  /** Cảnh báo xác nhận khi user đổi giá trị này (vd điểm dừng #5) */
  warning?: string
  /** Consumer cụ thể trong code — tham số này chi phối hàm nào */
  appliesTo: string
}

export interface TuningStateEntry extends TuningSpec {
  /** Giá trị thô trong TuningParam (null = chưa ai đặt) */
  storeValue: string | null
  /** Giá trị hiệu lực consumer đang dùng */
  effectiveValue: number | string
  source: TuningSource
}

/**
 * Một dòng audit nhật ký tinh chỉnh (P2-M2 — review task-98). Mỗi set/reset
 * qua API sinh 1 dòng: giá trị STORE trước/sau + giá trị HIỆU LỰC chụp tại
 * thời điểm ghi (env có thể đổi sau này — snapshot là nguồn tin của audit).
 * Transport API → UI (createdAt ISO string).
 */
export interface TuningChangeLogEntry {
  /** id autoincrement (tiebreak tất định FB-P2-R1-02 — không phải cuid) */
  id: number
  /** Tham số bị đổi — trùng key trong TUNING_SPECS */
  key: string
  /** 'set' (đặt override) | 'reset' (bỏ override) */
  action: 'set' | 'reset'
  /** Giá trị STORE trước đổi (null = chưa có override) */
  fromStoreValue: string | null
  /** Giá trị STORE sau đổi (null = override đã bỏ) */
  toStoreValue: string | null
  /** Giá trị hiệu lực trước đổi (chuỗi hoá — số giữ nguyên chuỗi chuẩn hoá) */
  fromEffectiveValue: string
  /** Giá trị hiệu lực sau đổi */
  toEffectiveValue: string
  /** Thời điểm ghi (ISO 8601) */
  createdAt: string
}

/**
 * Số dòng audit giữ lại tối đa (prune sau mỗi lần ghi — bảng nhỏ, quét rẻ).
 * Đặt ở neural-types (client-safe) để UI hiển thị mà KHÔNG kéo tuning-store
 * (server — phụ thuộc Prisma) vào bundle client.
 */
export const TUNING_CHANGE_LOG_CAP = 500

export interface NeuralNodeFn {
  name: string
  file: string
  line?: number
}

export interface NeuralNode {
  id: string
  layer: string
  title: string
  subtitle: string
  description: string
  /** Công thức/mô tả thuật toán (render monospace) */
  algorithm?: string
  algorithmNote?: string
  functions: NeuralNodeFn[]
  /** Các tuning key gắn với node này (rỗng = node chỉ đọc) */
  paramKeys: string[]
}

export interface NeuralEdge {
  id: string
  from: string
  to: string
  /** Nhãn dòng chảy — hiển thị tooltip/legend */
  label: string
  /**
   * data = dòng chính (cyan, chấm chạy) · reward = tín hiệu thưởng học
   * (amber, đứt nét, chạy ngược) · feedback = điều tiết ngược (fuchsia) ·
   * read = truy vấn đọc (mảnh, xám)
   */
  kind: 'data' | 'reward' | 'feedback' | 'read'
}

export interface NeuralLayer {
  id: string
  /** Số thứ tự hiển thị "LỚP N" */
  index: number
  title: string
  subtitle: string
  /** Màu nhấn tailwind (cyan/teal/amber/violet/fuchsia/emerald) */
  accent: string
}

export interface NeuralGraph {
  layers: NeuralLayer[]
  nodes: NeuralNode[]
  edges: NeuralEdge[]
}

// ==================== 1. TUNING SPECS (14 tham số vận hành thực) ====================

export const TUNING_SPECS: readonly TuningSpec[] = [
  {
    key: 'q_learning_alpha',
    label: 'α — tốc độ học Q',
    description: 'Bước nhảy mỗi lần cập nhật Q(s,a). α nhỏ = thận trọng, chống nhiễu 1 run; α lớn = học nhanh nhưng dao động.',
    nodeId: 'q-table',
    type: 'number',
    min: 0.01,
    max: 1,
    step: 0.01,
    default: 0.1,
    appliesTo: 'updateQ — mọi bước Q-learning (W1 workflow + W2 goal-loop)',
  },
  {
    key: 'q_learning_gamma',
    label: 'γ — chiết khấu tương lai',
    description: 'Trọng số giá trị trạng thái kế tiếp γ·maxQ(s′). γ cao = coi trọng tài thưởng xa; γ = 0 = chỉ nhìn phần thưởng tức thì.',
    nodeId: 'q-table',
    type: 'number',
    min: 0,
    max: 0.999,
    step: 0.005,
    default: 0.9,
    appliesTo: 'updateQ — mọi bước Q-learning',
  },
  {
    key: 'updateq_step_timeout_ms',
    label: 'Timeout 1 bước updateQ',
    description: 'Belt-and-suspenders chống link treo làm đóng băng chuỗi học (Prisma socket-timeout ~5s vẫn là hàng rào đầu).',
    nodeId: 'q-table',
    type: 'number',
    min: 2000,
    max: 60000,
    step: 1000,
    default: 20000,
    unit: 'ms',
    appliesTo: 'updateQStep — timeout tầng app',
  },
  {
    key: 'q_advice_min_visits',
    label: 'Ngưỡng visits cho Q-advice',
    description: 'Top-Q chỉ được gắn PLAN-hint / badge khi số lần ghé ≥ ngưỡng này (đủ dữ liệu mới tin — §P6-M4).',
    nodeId: 'q-advice',
    type: 'number',
    min: 1,
    max: 100,
    step: 1,
    default: 10,
    appliesTo: 'agent-goal-loop PLAN hint + advisory dropdown',
  },
  {
    key: 'runtime_model_policy',
    label: 'RUNTIME_MODEL_POLICY',
    description:
      'off = strictly-one-primary (mọi call dùng model cấu hình). softmax = chọn model khởi đầu theo π(a)=softmax(Q/τ) — chống 429-cascade, Q vẫn học ở cả 2 chế độ.',
    nodeId: 'softmax-policy',
    type: 'enum',
    enumValues: ['off', 'softmax'],
    default: 'off',
    envKey: 'RUNTIME_MODEL_POLICY',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'softmax' ? 'softmax' : 'off'
    },
    warning:
      'ĐIỂM DỪNG #5: user đã chốt giữ OFF trên đường nóng. Bật softmax = mọi call agent bắt đầu chọn model theo Q-bảng (QEntry đang rất ít dữ liệu → gần uniform). Q vẫn học ở cả 2 chế độ.',
    appliesTo: 'maybeApplySoftmaxModelPolicy — chọn model khởi đầu chuỗi Zen',
  },
  {
    key: 'runtime_model_tau',
    label: 'τ — nhiệt độ softmax',
    description: 'τ nhỏ → sát argmax (thiên về model Q cao nhất); τ lớn → đều nhau (chống cascade). Floor 0.05 giữ tính ngẫu nhiên.',
    nodeId: 'softmax-policy',
    type: 'number',
    min: 0.05,
    max: 5,
    step: 0.05,
    default: 0.5,
    envKey: 'RUNTIME_MODEL_TAU',
    appliesTo: 'softmaxPolicy(scores, τ) khi policy=softmax',
  },
  {
    key: 'episodic_epsilon',
    label: 'ε — khám phá episodic',
    description: 'Xác suất hoán vị slot cuối top-5 lessons bằng ứng viên rank 6+ (ε-greedy bandit — lesson được thí nghiệm sẽ được chấm điểm sau run). 0 = tắt khám phá.',
    nodeId: 'preact',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.15,
    envKey: 'TMO_EPISODIC_EPSILON',
    appliesTo: 'applyEpsilonExploration — PRE-ACT retrieval',
  },
  {
    key: 'adaptation_stats_gate',
    label: 'ADAPTATION_STATS_GATE',
    description: 'on = chặn THẬT chuyển chiến lược khi gate thống kê không đạt; off = log-only (vẫn ghi SAL, không chặn).',
    nodeId: 'stats-gate',
    type: 'enum',
    enumValues: ['on', 'off'],
    default: 'off',
    envKey: 'ADAPTATION_STATS_GATE',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      if (v === 'on' || v === '1' || v === 'true') return 'on'
      if (v === 'off' || v === '0' || v === 'false') return 'off'
      return undefined
    },
    appliesTo: 'isAdaptationStatsGateBlocking — adaptation engine',
  },
  {
    key: 'matryoshka_pilot',
    label: 'MATRYOSHKA_PILOT',
    description: 'Bật dual-write bản rút gọn 512 chiều vào pilot collection (cờ đo lường — đường đọc vẫn 2048 cho tới khi recall đối chứng đạt).',
    nodeId: 'chunk-embed',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'MATRYOSHKA_PILOT',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' || v === '1' || v === 'true' ? 'on' : 'off'
    },
    appliesTo: 'isMatryoshkaPilotEnabled — pipeline embedding',
  },
  {
    key: 'lesson_dedup_jaccard',
    label: 'Ngưỡng Jaccard gộp lesson',
    description: 'Lesson mới trùng từ khoá với lesson cũ ≥ ngưỡng này → MERGE (+confidence) thay vì tạo bản trùng. Hạ thấp = gộp hung hãn hơn.',
    nodeId: 'lessons',
    type: 'number',
    min: 0.3,
    max: 1,
    step: 0.01,
    default: 0.55,
    appliesTo: 'consolidateLesson — episodic memory',
  },
  {
    key: 'doc_dedup_near_dup_threshold',
    label: 'Ngưỡng near-dup tài liệu',
    description: 'Cosine ≥ ngưỡng trên MỌI probe chunk + cùng Document gốc → kết luận trùng (409). 0.98 = chỉ bắt bản tái xuất gần nguyên văn.',
    nodeId: 'doc-dedup',
    type: 'number',
    min: 0.9,
    max: 1,
    step: 0.005,
    default: 0.98,
    appliesTo: 'decideNearDuplicate — lớp 2 chống index trùng',
  },
  {
    key: 'anomaly_iqr_k',
    label: 'k — rìa Tukey IQR',
    description: 'Điểm bị coi bất thường khi duration > Q3 + k·IQR. k nhỏ = nhạy hơn (nhiều cảnh báo hơn), k lớn = chỉ bắt outlier rõ rệt.',
    nodeId: 'anomaly',
    type: 'number',
    min: 0.5,
    max: 4,
    step: 0.1,
    default: 1.5,
    appliesTo: 'scanToolMetricAnomalies — iqrBounds',
  },
  {
    key: 'anomaly_min_group_size',
    label: 'n tối thiểu mỗi nhóm',
    description: 'Nhóm (tool × role) ít hơn n điểm thì bỏ qua — quantile trên mẫu nhỏ chỉ là nhiễu (LLN/CLT).',
    nodeId: 'anomaly',
    type: 'number',
    min: 5,
    max: 100,
    step: 1,
    default: 20,
    appliesTo: 'scanToolMetricAnomalies — lọc nhóm nhỏ',
  },
  {
    // BRAIN-P2 (blueprint §4.2) — cờ runtime của Brain-A "V3": chỉ bật khi
    // muốn MLP dẫn đường chuỗi calibration (V3 active = đã thắng V2 qua
    // 5-fold CV Brier). Chuỗi hiệu lực STORE > ENV > DEFAULT=off đúng
    // runtime_model_policy — tinh chỉnh trên tab Kiến trúc không restart.
    key: 'calibration_v3',
    label: 'CALIBRATION_V3',
    description:
      'off = chuỗi calibration V1→V2 giữ nguyên. on = Brain-A MLP 10→16→1 dẫn đường khi có bản active (chỉ set sau khi thắng V2 qua 5-fold CV Brier ngặt); mọi lỗi → fail-open về V2/V1/raw.',
    nodeId: 'goal-loop',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'CALIBRATION_V3',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' ? 'on' : 'off'
    },
    warning:
      'Bật = runtime KB confidence đi qua MLP Brain-A khi bản active tồn tại (thắng CV rồi mới active). Không có bản active → flag on cũng vô hiệu (fail-open về V2). Rollback = set lại off hoặc deactive bản BrainModel.',
    appliesTo: 'tryCalibrationV3 — dẫn đường getCalibratedConfidence (kb-access) khi active',
  },
] as readonly TuningSpec[]

/** Tra spec theo key (O(1) qua Map dựng sẵn). */
const SPEC_BY_KEY = new Map<string, TuningSpec>(TUNING_SPECS.map(s => [s.key, s]))

export function getTuningSpec(key: string): TuningSpec | undefined {
  return SPEC_BY_KEY.get(key)
}

// ==================== 2. NEURAL GRAPH — 6 LỚP × 23 NODE × 37 CẠNH ====================

export const NEURAL_LAYERS: readonly NeuralLayer[] = [
  {
    id: 'input',
    index: 1,
    title: 'Đầu vào',
    subtitle: 'nhiệm vụ & tài liệu đi vào hệ thống',
    accent: 'cyan',
  },
  {
    id: 'processing',
    index: 2,
    title: 'Xử lý',
    subtitle: 'dedup · embedding · entity · pre-act',
    accent: 'teal',
  },
  {
    id: 'storage',
    index: 3,
    title: 'Lưu trữ',
    subtitle: 'SQLite · Qdrant · Neo4j · R2',
    accent: 'amber',
  },
  {
    id: 'learning',
    index: 4,
    title: 'Học',
    subtitle: 'Q-learning · adaptation · lessons',
    accent: 'violet',
  },
  {
    id: 'decision',
    index: 5,
    title: 'Quyết định',
    subtitle: 'gate · softmax policy · strategy',
    accent: 'fuchsia',
  },
  {
    id: 'output',
    index: 6,
    title: 'Đầu ra',
    subtitle: 'LLM call · response · advisory',
    accent: 'emerald',
  },
]

export const NEURAL_NODES: readonly NeuralNode[] = [
  // ── LỚP 1 · ĐẦU VÀO ──
  {
    id: 'doc-upload',
    layer: 'input',
    title: 'Nạp tài liệu',
    subtitle: 'PDF → R2 + Document',
    description:
      'Cửa ngõ GraphRAG: user upload PDF → hash sha256 bytes, lưu file gốc sang R2, tạo Document row trong SQLite rồi đẩy vào JobQueue của pipeline ingestion.',
    algorithm: 'sha256(bytes) — lớp exact-dup chặn tái tải cùng nội dung',
    functions: [
      { name: 'sha256Hex', file: 'src/lib/ingestion/doc-dedup.ts', line: 51 },
      { name: 'findExactDuplicate', file: 'src/lib/ingestion/doc-dedup.ts', line: 60 },
    ],
    paramKeys: [],
  },
  {
    id: 'chat',
    layer: 'input',
    title: 'Smolab Chat',
    subtitle: 'user message',
    description:
      'Ngõ vào hội thoại đơn-agent: user message → openclaw chat → enqueue GoalLoopJob (durable, checkpoint/resume sau crash) cho Omega chạy vòng mục tiêu.',
    functions: [{ name: 'POST /api/openclaw/chat', file: 'src/app/api/openclaw/chat/route.ts' }],
    paramKeys: [],
  },
  {
    id: 'goal-loop',
    layer: 'input',
    title: 'Goal Loop',
    subtitle: 'vòng chạy agent (Omega)',
    description:
      'Vòng lặp mục tiêu: PLAN → tool calls → EVALUATE → conclude. Đầu mỗi run gọi PRE-ACT truy hồi episodic; cuối run trọng tài chấm verdict → thưởng W2 cho Q-table.',
    algorithm: 'W2: reward = refuted>0 ? −1 : (confirmed>0 ∧ complete ? +1 : 0)',
    functions: [
      { name: 'runGoalLoop (PLAN hint)', file: 'src/lib/agent-goal-loop.ts', line: 2499 },
      { name: 'W2 verdict reward', file: 'src/lib/agent-goal-loop.ts', line: 5887 },
    ],
    paramKeys: ['q_advice_min_visits', 'calibration_v3'],
  },
  {
    id: 'workflow',
    layer: 'input',
    title: 'Code-team Workflow',
    subtitle: 'FORGE · MEGATRON · SENTINEL…',
    description:
      'Pipeline code-team: strategy routing (mode × tier) chọn cách chạy; kết quả mỗi vòng ghi StrategyAdaptationLog — outcome tốt/xấu trở thành thưởng W1 cho Q-table.',
    functions: [
      { name: 'runWorkflow', file: 'src/lib/code-team/workflow-engine.ts' },
      { name: 'W1 markSessionAdaptationOutcome', file: 'src/lib/code-team/workflow-engine.ts', line: 1736 },
    ],
    paramKeys: [],
  },

  // ── LỚP 2 · XỬ LÝ ──
  {
    id: 'doc-dedup',
    layer: 'processing',
    title: 'Dedup tài liệu',
    subtitle: 'sha256 + near-dup cosine',
    description:
      'Hai lớp chống index trùng: exact (sha256 bytes) tại upload; near-dup sau chunk — embed 3 chunk đầu, mọi probe cosine ≥ ngưỡng và trỏ về cùng Document gốc → 409, chunk không bao giờ ô nhiễm Qdrant.',
    algorithm: 'trùng ⟺ probes ≠ ∅ ∧ mọi probe có hit ≥ ngưỡng ∧ top-1 cùng Document',
    algorithmNote: 'Triết lý fail-open: thiếu bằng chứng → KHÔNG kết luận trùng',
    functions: [
      { name: 'decideNearDuplicate', file: 'src/lib/ingestion/doc-dedup.ts', line: 122 },
      { name: 'probeNearDuplicate', file: 'src/lib/ingestion/doc-dedup.ts', line: 225 },
    ],
    paramKeys: ['doc_dedup_near_dup_threshold'],
  },
  {
    id: 'chunk-embed',
    layer: 'processing',
    title: 'Chunk + Embedding',
    subtitle: '2048d · MRL pilot 512',
    description:
      'Chunk text → vector 2048 chiều (community embedding, cache theo EmbeddingModelVersion) → upsert Qdrant. Pilot Matryoshka đồng thời ghi bản 512 chiều đầu để đối chứng recall.',
    algorithm: 'v₅₁₂ = v₂₀₄₈[0..511] — cosine bất biến theo scale, không renormalize',
    functions: [
      { name: 'generateEmbeddingBatch', file: 'src/lib/embeddings.ts' },
      { name: 'truncateMatryoshka', file: 'src/lib/embeddings.ts', line: 762 },
      { name: 'isMatryoshkaPilotEnabled', file: 'src/lib/embeddings.ts', line: 745 },
    ],
    paramKeys: ['matryoshka_pilot'],
  },
  {
    id: 'entity-res',
    layer: 'processing',
    title: 'Entity Resolution',
    subtitle: 'Naive Bayes + fuzzy 0.85',
    description:
      'Hợp nhất thực thể trùng tên/đồng nghĩa giữa các tài liệu: Naive Bayes trên đặc trưng dạng (bins=10, Laplace smoothing) với vùng xám 0.5 — không chắc thì bỏ phiếu thay vì đoán bừa; bổ trợ fuzzy-match 0.85 và cosine embedding.',
    algorithm: 'P(match|f) ∝ P(match)·∏ P(fᵢ|match) — Laplace + gray-zone 0.5',
    functions: [
      { name: 'resolveEntities (NB)', file: 'src/lib/ingestion/entity-resolver.ts', line: 212 },
      { name: 'fuzzy threshold 0.85', file: 'src/lib/ingestion/entity-resolver.ts', line: 513 },
    ],
    paramKeys: [],
  },
  {
    id: 'preact',
    layer: 'processing',
    title: 'Episodic Pre-act',
    subtitle: 'ε-greedy retrieval',
    description:
      'Chạy TRƯỚC khi agent hành động: rút entities từ task → lessons Neo4j + episode tương tự Qdrant (cosine ≥ 0.7) → cảnh báo lỗi chưa resolve + lesson confidence ≥ 0.7 áp dụng ngay. ε-greedy thí nghiệm lesson rank 6+ ở slot cuối để mở khoá confidence đóng băng.',
    algorithm: 'P(đổi slot 5) = ε — lesson thí nghiệm được validateAppliedLessons chấm ± sau run',
    algorithmNote: 'Fail-open tuyệt đối: Neo4j/Qdrant chết → block rỗng, agent chạy bình thường',
    functions: [
      { name: 'buildPreActContext', file: 'src/lib/episodic-memory/preact.ts', line: 85 },
      { name: 'applyEpsilonExploration', file: 'src/lib/episodic-memory/preact.ts', line: 63 },
      { name: 'buildMidRunSimilarErrorBlock', file: 'src/lib/episodic-memory/preact.ts', line: 243 },
    ],
    paramKeys: ['episodic_epsilon'],
  },

  // ── LỚP 3 · LƯU TRỮ ──
  {
    id: 'sqlite',
    layer: 'storage',
    title: 'SQLite / Prisma',
    subtitle: '96 models · WAL mode',
    description:
      'Cột xương vận hành: mọi bảng nghiệp vụ (Document, GoalLoopJob, QEntry, StrategyAdaptationLog, LessonRecord, TokenUsage…) nằm trong một file SQLite duy nhất, chạy WAL + busy_timeout 5s qua singleton client có guard env-leak.',
    functions: [
      { name: 'db (singleton + PRAGMA)', file: 'src/lib/db.ts', line: 169 },
      { name: 'QEntry model', file: 'prisma/schema.prisma', line: 2472 },
      { name: 'TuningParam model', file: 'prisma/schema.prisma', line: 2497 },
    ],
    paramKeys: [],
  },
  {
    id: 'qdrant',
    layer: 'storage',
    title: 'Qdrant',
    subtitle: 'documents + chunks 2048d',
    description:
      'Vector DB: collection documents (điểm tra cứu tài liệu) + chunks (embedding 2048 chiều, đối chiếu dim mỗi lần health-check). Cũng lưu episode embedding cho searchSimilarEpisodes của PRE-ACT.',
    functions: [{ name: 'searchSimilar', file: 'src/lib/qdrant.ts' }],
    paramKeys: [],
  },
  {
    id: 'neo4j',
    layer: 'storage',
    title: 'Neo4j AuraDB',
    subtitle: 'Entity · REL · Lesson graph',
    description:
      'Graph tri thức: node Entity/Relationship từ entity-resolution, LessonNode (MERGE khi pattern lặp), EpisodeNode + SIMILAR_TO (cosine ≥ 0.8). Kho bài học chính của episodic memory.',
    functions: [{ name: 'getLessonsForContext', file: 'src/lib/episodic-memory/episodic-neo4j.ts' }],
    paramKeys: [],
  },
  {
    id: 'r2',
    layer: 'storage',
    title: 'Cloudflare R2',
    subtitle: 'file gốc PDF',
    description: 'Object storage giữ bản gốc PDF đã upload — nguồn sự thật để re-extract / re-embed khi pipeline đổi model.',
    functions: [],
    paramKeys: [],
  },

  // ── LỚP 4 · HỌC ──
  {
    id: 'q-table',
    layer: 'learning',
    title: 'Q-Learning (QEntry)',
    subtitle: 'tabular · α=0.1 · γ=0.9',
    description:
      'Bảng Q(s,a) học từ 2 điểm thưởng: W1 (workflow đổi strategy thành/bại ±1) + W2 (verdict trọng tài goal-loop ±1, pending bỏ qua). Không cần DQN/PPO — không gian trạng thái nhỏ (mode × tier × model/strategy). Chuỗi update tuần tự in-process chống lost-update; reward kẹp [−1,1].',
    algorithm: 'Q(s,a) ← Q(s,a) + α·[r + γ·max_a′ Q(s′,a′) − Q(s,a)]',
    algorithmNote: 'State key `mode-X-tier-Y` tái dùng format historical-feedback; runtime chat dùng mode-agent-tier-1 hội tụ',
    functions: [
      { name: 'qLearningUpdate', file: 'src/lib/learning/q-table.ts', line: 91 },
      { name: 'updateQ (chuỗi tuần tự)', file: 'src/lib/learning/q-table.ts', line: 229 },
      { name: 'softmaxPolicy', file: 'src/lib/learning/q-table.ts', line: 122 },
      { name: 'deterministicSeed (FNV-1a + fmix32)', file: 'src/lib/learning/q-table.ts', line: 158 },
      { name: 'getTopQAdvice', file: 'src/lib/learning/q-table.ts', line: 352 },
    ],
    paramKeys: ['q_learning_alpha', 'q_learning_gamma', 'updateq_step_timeout_ms'],
  },
  {
    id: 'adaptation',
    layer: 'learning',
    title: 'Adaptation Engine',
    subtitle: 'SAL · chuyển chiến lược',
    description:
      'Khi workflow gặp failure-pattern, engine đề xuất chuyển strategy (reduce_scope, change_fix_approach…) và ghi StrategyAdaptationLog. Kết thúc session, markSessionAdaptationOutcome đóng SAL + trả tín hiệu cho Q-table (W1).',
    algorithm: 'confidence = boost khi pattern lặp · toStrategy trở thành actionKey của W1',
    functions: [
      { name: 'markSessionAdaptationOutcome', file: 'src/lib/learning/adaptation-engine.ts', line: 324 },
      { name: 'getAdaptedMaxIterations', file: 'src/lib/learning/adaptation-engine.ts', line: 249 },
    ],
    paramKeys: [],
  },
  {
    id: 'lessons',
    layer: 'learning',
    title: 'Lessons',
    subtitle: 'Jaccard ≥ 0.55 → MERGE',
    description:
      'Bài học tự suy ra từ episode: pattern lặp (đủ giống về từ khoá) củng cố lesson cũ +confidence/validated; pattern mới sinh lesson confidence 0.6. Song song mirror SQLite ↔ Neo4j (fallback tự backfill khi lệch).',
    algorithm: 'J(A,B) = |A∩B| / |A∪B| (word overlap) ≥ ngưỡng → MERGE',
    algorithmNote: 'Confidence lifecycle: 0.6 khởi điểm · ≥0.7 auto-apply · +0.05 validate · −0.1 fail',
    functions: [
      { name: 'consolidateLesson', file: 'src/lib/episodic-memory/lessons.ts' },
      { name: 'EPISODIC_THRESHOLDS', file: 'src/lib/episodic-memory/types.ts', line: 151 },
    ],
    paramKeys: ['lesson_dedup_jaccard'],
  },
  {
    id: 'hist-feedback',
    layer: 'learning',
    title: 'Historical Feedback',
    subtitle: 'Wilson CI trust',
    description:
      'Tín nhiệm thống kê theo agent/model: chỉ tin lịch sử khi đủ mẫu (n ≥ 5) VÀ khoảng tin cậy Wilson hẹp (width ≤ 0.5) — tránh cả tin 2-3 run đỏ may mắn. Rules hợp lệ nuôi Strategy Adapter.',
    algorithm: 'trust ⟺ n ≥ TRUST_MIN_N ∧ CI_width ≤ TRUST_MAX_CI_WIDTH (Wilson)',
    functions: [
      { name: 'TRUST_MIN_N / TRUST_MAX_CI_WIDTH', file: 'src/lib/learning/historical-feedback.ts', line: 25 },
    ],
    paramKeys: [],
  },
  {
    id: 'anomaly',
    layer: 'learning',
    title: 'Anomaly Detector',
    subtitle: 'IQR Tukey · k=1.5',
    description:
      'Quét ToolMetric theo nhóm (tool × role): duration vượt rìa Q3 + k·IQR trong 24h qua → ghi MetricAnomaly (khử trùng theo giờ), dọn bản cũ 30 ngày. Cảnh báo nuôi hints cho Strategy Adapter.',
    algorithm: 'high = Q3 + k·IQR · score = (x − Q3)/IQR',
    functions: [
      { name: 'scanToolMetricAnomalies', file: 'src/lib/learning/anomaly-detector.ts', line: 75 },
      { name: 'iqrBounds', file: 'src/lib/stats.ts' },
    ],
    paramKeys: ['anomaly_iqr_k', 'anomaly_min_group_size'],
  },

  // ── LỚP 5 · QUYẾT ĐỊNH ──
  {
    id: 'stats-gate',
    layer: 'decision',
    title: 'Stats Gate',
    subtitle: 'χ²/Fisher · Welch-t',
    description:
      'Cổng thống kê trước khi adaptation đổi chiến lược thật: so sánh outcome 2 nhóm (cũ vs mới) bằng χ² (Yates → Fisher khi expected < 5, α=0.05 một phía, tối thiểu 10 mẫu) + Welch-t bổ trợ trên cycles. Không đạt → không cho chuyển (hoặc chỉ log khi gate off).',
    algorithm: 'χ² ≥ critical (df=1, α=0.05) ∧ n ≥ 10 → cho phép; ngược lại block',
    functions: [
      { name: 'isAdaptationStatsGateBlocking', file: 'src/lib/learning/adaptation-stats.ts', line: 186 },
      { name: 'evaluateAdaptationGateForPair', file: 'src/lib/learning/adaptation-stats.ts', line: 236 },
    ],
    paramKeys: ['adaptation_stats_gate'],
  },
  {
    id: 'softmax-policy',
    layer: 'decision',
    title: 'Softmax Model Policy',
    subtitle: 'π(a) = e^{Q/τ} / Σ',
    description:
      'Khi policy=softmax: ứng viên = model Zen có caps coding ∧ reasoning và không bị health-block → điểm Q(s,a) → phân phối softmax(τ) → chọn tất định theo seed hash(sessionId, cycle) (chạy lại được). Agent có override tường minh được tôn trọng; failover chuỗi cũ giữ nguyên toàn bộ.',
    algorithm: 'π(a) = exp(Q(s,a)/τ) / Σ_b exp(Q(s,b)/τ) · seed = fmix32(FNV-1a(session|cycle))',
    algorithmNote: 'MẶC ĐỊNH OFF (điểm dừng #5) — Q vẫn học ở cả 2 chế độ',
    functions: [
      { name: 'maybeApplySoftmaxModelPolicy', file: 'src/lib/llm.ts', line: 4418 },
      { name: 'getQAdvice', file: 'src/lib/learning/q-table.ts', line: 323 },
      { name: 'pickIndexBySeed', file: 'src/lib/learning/q-table.ts', line: 185 },
    ],
    paramKeys: ['runtime_model_policy', 'runtime_model_tau'],
  },
  {
    id: 'strategy-adapter',
    layer: 'decision',
    title: 'Strategy Adapter',
    subtitle: 'DEFAULT_RULES + hints',
    description:
      'Bộ quy tắc chuyển hướng theo dấu hiệu: redteam_breach ×2 → siết ngưỡng từ chối; repeated_error ×3 → đổi cách tiếp cận; count ≥ 2 → đọc lint rules trước… Hints cache 60s, tối đa 3 hints, TTL an toàn khi DB chậm (timeout 3s).',
    algorithm: 'rule: (pattern, count) → action (tighten_refusal_threshold, change_fix_approach…)',
    functions: [
      { name: 'DEFAULT_RULES', file: 'src/lib/learning/strategy-adapter.ts', line: 30 },
      { name: 'getAdaptedHints (cache 60s)', file: 'src/lib/learning/strategy-adapter.ts', line: 406 },
    ],
    paramKeys: [],
  },

  // ── LỚP 6 · ĐẦU RA ──
  {
    id: 'llm-call',
    layer: 'output',
    title: 'LLM Zen',
    subtitle: 'callLLMForAgent',
    description:
      'Điểm gọi model của agent: chọn model khởi đầu (cấu hình hoặc softmax policy) → chuỗi failover Zen (xoay 4 key, cooldown 429, breaker 10 phút) → reasoning effort cao nhất theo model. Mọi call ghi token usage theo provider/model/agent.',
    algorithm: 'failover: primary → alternates (bỏ model bị health-block) — softmax chỉ đổi điểm khởi đầu',
    functions: [
      { name: 'callLLMForAgent', file: 'src/lib/llm.ts', line: 5535 },
      { name: 'zenReasoningEffortForModel', file: 'src/lib/llm.ts', line: 4494 },
    ],
    paramKeys: [],
  },
  {
    id: 'agent-response',
    layer: 'output',
    title: 'Agent Response',
    subtitle: 'trọng tài chấm verdict',
    description:
      'Kết luận run: trọng tài độc lập resolveArbiterVerdicts chấm từng phần việc ĐẠT/CHƯA ĐẠT — kết quả trở thành verdict W2 (+1 confirmed / −1 refuted) nuôi Q-table, đồng thời ghi AgentRunRecord cho Historical Feedback.',
    algorithm: 'verdict = ĐẠT% ≥ ngưỡng → confirmed; có phần refuted → refuted; còn lại pending (bỏ)',
    functions: [
      { name: 'resolveArbiterVerdictsDetailed', file: 'src/lib/metrics-db.ts', line: 410 },
      { name: 'W2 wiring', file: 'src/lib/agent-goal-loop.ts', line: 5887 },
    ],
    paramKeys: [],
  },
  {
    id: 'q-advice',
    layer: 'output',
    title: 'Q-Advice',
    subtitle: 'PLAN hint + dropdown badge',
    description:
      'Đầu ra advisory của bảng Q: PLAN-prompt gắn 1 dòng Q-HINT (model có thưởng học cao nhất) khi top-Q đủ visits; dropdown model trong UI Agents/Smolab hiện badge Q cyan kèm tooltip. Chỉ tham khảo — không ép buộc.',
    algorithm: 'hiện hint ⟺ top-1 visits ≥ ngưỡng (mặc định 10)',
    functions: [
      { name: 'getTopQAdvice', file: 'src/lib/learning/q-table.ts', line: 352 },
      { name: 'dropdown badge', file: 'src/components/agents/agents-module.tsx' },
    ],
    paramKeys: ['q_advice_min_visits'],
  },
]

export const NEURAL_EDGES: readonly NeuralEdge[] = [
  // Dòng tài liệu (data)
  { id: 'e01', from: 'doc-upload', to: 'doc-dedup', label: 'bytes → sha256', kind: 'data' },
  { id: 'e02', from: 'doc-dedup', to: 'chunk-embed', label: 'bản hợp lệ', kind: 'data' },
  { id: 'e03', from: 'chunk-embed', to: 'qdrant', label: 'vector 2048d', kind: 'data' },
  { id: 'e04', from: 'chunk-embed', to: 'sqlite', label: 'EmbeddingCache', kind: 'data' },
  { id: 'e05', from: 'chunk-embed', to: 'entity-res', label: 'text chunks', kind: 'data' },
  { id: 'e06', from: 'entity-res', to: 'neo4j', label: 'Entity + REL nodes', kind: 'data' },
  { id: 'e07', from: 'entity-res', to: 'sqlite', label: 'LocalResolvedEntity', kind: 'data' },
  { id: 'e08', from: 'doc-upload', to: 'sqlite', label: 'Document row', kind: 'data' },
  { id: 'e09', from: 'doc-upload', to: 'r2', label: 'file gốc PDF', kind: 'data' },
  // Dòng agent (data)
  { id: 'e10', from: 'chat', to: 'goal-loop', label: 'user message → job', kind: 'data' },
  { id: 'e11', from: 'goal-loop', to: 'preact', label: 'task → truy hồi ký ức', kind: 'data' },
  { id: 'e12', from: 'goal-loop', to: 'llm-call', label: 'callLLMForAgent', kind: 'data' },
  { id: 'e13', from: 'llm-call', to: 'softmax-policy', label: 'zenModel khởi đầu?', kind: 'data' },
  { id: 'e14', from: 'softmax-policy', to: 'llm-call', label: 'model được chọn', kind: 'data' },
  { id: 'e15', from: 'llm-call', to: 'agent-response', label: 'token stream', kind: 'data' },
  { id: 'e16', from: 'goal-loop', to: 'agent-response', label: 'kết luận run', kind: 'data' },
  { id: 'e17', from: 'goal-loop', to: 'sqlite', label: 'GoalLoopJob + ChatMessage', kind: 'data' },
  { id: 'e18', from: 'workflow', to: 'sqlite', label: 'WorkflowSession + metrics', kind: 'data' },
  { id: 'e19', from: 'q-table', to: 'softmax-policy', label: 'Q(s,a) scores', kind: 'data' },
  { id: 'e20', from: 'q-table', to: 'q-advice', label: 'getTopQAdvice', kind: 'data' },
  // Vòng học (reward — chạy ngược về Q-table)
  { id: 'e21', from: 'agent-response', to: 'q-table', label: 'W2: verdict ±1', kind: 'reward' },
  { id: 'e22', from: 'adaptation', to: 'q-table', label: 'W1: outcome ±1', kind: 'reward' },
  { id: 'e23', from: 'workflow', to: 'adaptation', label: 'failure-pattern → SAL', kind: 'data' },
  // Điều tiết ngược (feedback)
  { id: 'e24', from: 'adaptation', to: 'workflow', label: 'strategy mới cho session', kind: 'feedback' },
  { id: 'e25', from: 'adaptation', to: 'stats-gate', label: 'đánh giá cặp chiến lược', kind: 'data' },
  { id: 'e26', from: 'stats-gate', to: 'adaptation', label: 'cho phép / chặn', kind: 'feedback' },
  { id: 'e27', from: 'hist-feedback', to: 'strategy-adapter', label: 'Wilson trust rules', kind: 'data' },
  { id: 'e28', from: 'strategy-adapter', to: 'workflow', label: 'adapted hints', kind: 'feedback' },
  { id: 'e29', from: 'anomaly', to: 'strategy-adapter', label: 'cảnh báo bất thường', kind: 'data' },
  { id: 'e30', from: 'goal-loop', to: 'q-advice', label: 'PLAN hint (visits ≥ N)', kind: 'read' },
  // Truy vấn đọc (read)
  { id: 'e31', from: 'preact', to: 'lessons', label: 'lessons theo entities', kind: 'read' },
  { id: 'e32', from: 'preact', to: 'qdrant', label: 'searchSimilarEpisodes', kind: 'read' },
  { id: 'e33', from: 'lessons', to: 'neo4j', label: 'LessonNode MERGE', kind: 'data' },
  { id: 'e34', from: 'lessons', to: 'sqlite', label: 'LessonRecord mirror', kind: 'data' },
  { id: 'e35', from: 'hist-feedback', to: 'sqlite', label: 'AgentRunRecord', kind: 'read' },
  { id: 'e36', from: 'agent-response', to: 'hist-feedback', label: 'run outcome → Wilson', kind: 'read' },
  { id: 'e37', from: 'anomaly', to: 'sqlite', label: 'ToolMetric scan', kind: 'read' },
]

export const NEURAL_GRAPH: NeuralGraph = {
  layers: [...NEURAL_LAYERS],
  nodes: [...NEURAL_NODES],
  edges: [...NEURAL_EDGES],
}
