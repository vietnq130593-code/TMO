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

// ==================== 1. TUNING SPECS (25 tham số vận hành thực) ====================
// 13 gốc (neural-arch 2026-10-11) + thứ 14 calibration_v3 (BRAIN-P2) + thứ 15
// replay_eval (BRAIN-P3) + thứ 16–19 runtime_policy + 3 cờ organ kill-switch
// policy_organ_routing/adaptation/tuning (BRAIN-P4) + thứ 20–22 cờ trình
// bày BRAIN-UX (ui_brain_edit/ui_synapse_fx/ui_hitech — blueprint §9, user
// chốt 2026-10-12; BRAIN-LIVE cùng ngày hiệu đính default ui_synapse_fx
// 'off'→'on' — "đài quan sát não" tab BRAIN Smolab, chỉ thị user 2026-10-12)
// + thứ 23–25 trọng số composite reward w₁w₂w₃ (UX-2 nhóm C — override qua
// STORE›ENV›DEFAULT, log-only KHÔNG đổi).

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
  {
    // BRAIN-P3 (blueprint §4.3) — cờ runtime của Brain-B "Vọng" (surrogate
    // predictor): off = POST /api/brain/replay chỉ trả đo lường lịch sử
    // (bootstrap CI); on = báo cáo thêm ước lượng MLP của bản active (đầu
    // nào thắng baseline CV mới được nói). Chuỗi STORE > ENV > DEFAULT=off
    // đúng runtime_model_policy/calibration_v3 — tinh chỉnh không restart.
    key: 'replay_eval',
    label: 'REPLAY_EVAL',
    description:
      'off = replay-eval chỉ đo/báo cáo lịch sử (success rate + median tokens/latency kèm bootstrap CI). on = thêm ước lượng surrogate MLP (P(success)/E[tokens]/E[latency]) cho cấu hình — chỉ đầu đã thắng baseline 5-fold CV mới hiện; mọi nhánh fail-open về đo lường thuần.',
    nodeId: 'softmax-policy',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'REPLAY_EVAL',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' ? 'on' : 'off'
    },
    warning:
      'Bật = báo cáo replay /api/brain/replay kèm ước lượng MLP Brain-B khi có bản active (thắng CV rồi mới active). Replay luôn READ-ONLY (không ghi DB, không tự chạy thật). Không có bản active → flag on cũng vô hiệu (chỉ đo lường).',
    appliesTo: 'buildReplayReport — mở phần ước lượng MLP trong POST /api/brain/replay',
  },
  {
    // BRAIN-P4 (blueprint §4.4) — cờ master runtime của Brain-C "Lệnh"
    // (policy head): off = mixture π = λ·π_Q + (1−λ)·π_net không tham gia
    // đâu (3 cơ quan steering đều ngủ); on = cho phép TỪNG cơ quan (mỗi cái
    // vẫn cần cờ organ riêng bật thêm — kill-switch 2 lớp). Chuỗi hiệu lực
    // STORE > ENV > DEFAULT=off đúng calibration_v3/replay_eval.
    key: 'runtime_policy',
    label: 'RUNTIME_POLICY',
    description:
      'off = Brain-C "Lệnh" policy head không tham gia runtime (mặc định — composite reward đang log-only đợt quan sát). on = cho phép từng cơ quan (model routing / adaptation advisory / tuning proposals) nghe mixture — mỗi cơ quan vẫn cần cờ policy_organ_* riêng bật thêm.',
    nodeId: 'softmax-policy',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'RUNTIME_POLICY',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' ? 'on' : 'off'
    },
    warning:
      'Bật = cho phép Brain-C tham gia runtime QUA từng cơ quan (cờ policy_organ_*). Không có bản active (thắng π_Q CV) → flag on cũng vô hiệu (fail-open nghe Q nguyên vẹn). Composite reward vẫn log-only cho tới khi đủ 2 đợt quan sát (Q1 chốt 2026-10-12).',
    appliesTo: 'isRuntimePolicyEnabled — maybeMixModelProbs (llm.ts) · buildPolicyAdvisoryBlock (workflow-engine) · buildTuningProposals (report)',
  },
  {
    // BRAIN-P4 organ-1 kill-switch — model routing (llm.ts). Master
    // runtime_policy PHẢI on trước; organ này quyết định riêng routing có
    // nghe mixture không. Off → maybeApplySoftmaxModelPolicy y hệt trước P4.
    key: 'policy_organ_routing',
    label: 'POLICY_ORGAN_ROUTING',
    description:
      'Kill-switch organ model routing: off = softmax chọn model bằng π_Q thuần (y hệt trước BRAIN-P4). on = khi runtime_policy on VÀ Brain-C có bản active → probs được trộn mixture π = λ·π_Q + (1−λ)·π_net (seed-pick tất định giữ nguyên).',
    nodeId: 'softmax-policy',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'POLICY_ORGAN_ROUTING',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' ? 'on' : 'off'
    },
    warning: 'Bật = model routing nghe Brain-C (khi master + active). Tắt về off = rollback tức thì về π_Q thuần — kill-switch độc lập với 2 organ kia.',
    appliesTo: 'maybeMixModelProbs — trộn mixture vào maybeApplySoftmaxModelPolicy (src/lib/llm.ts)',
  },
  {
    // BRAIN-P4 organ-2 kill-switch — adaptation directives advisory text
    // (workflow-engine systemBlocks). Chỉ TEXT đề xuất — không đổi quyết định.
    key: 'policy_organ_adaptation',
    label: 'POLICY_ORGAN_ADAPTATION',
    description:
      'Kill-switch organ adaptation directives: off = không có advisory nào của Brain-C vào system prompt. on = khi runtime_policy on VÀ có bản active → block "ĐỀ XUẤT BRAIN-C" (đề xuất model + λ + CV) vào systemBlocks — advisory TEXT, không ép quyết định.',
    nodeId: 'softmax-policy',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'POLICY_ORGAN_ADAPTATION',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' ? 'on' : 'off'
    },
    warning: 'Bật = system prompt nhận thêm block đề xuất model của Brain-C (chỉ tham khảo). Tắt về off = không còn block — kill-switch độc lập với 2 organ kia.',
    appliesTo: 'buildPolicyAdvisoryBlock — systemBlocks workflow-engine (src/lib/code-team/workflow-engine.ts)',
  },
  {
    // BRAIN-P4 organ-3 kill-switch — tuning-store proposals (read-only).
    // Brain CHỈ đề xuất giá trị qua report GET /api/brain/policy — người
    // duyệt vẫn là user qua UI (TuningChangeLog chỉ ghi khi user áp dụng).
    key: 'policy_organ_tuning',
    label: 'POLICY_ORGAN_TUNING',
    description:
      'Kill-switch organ tuning proposals: off = GET /api/brain/policy trả danh sách đề xuất rỗng. on = Brain-C đề xuất giá trị tham số (vd runtime_model_policy=softmax khi Q ≥ 30 entry, runtime_policy=on khi có bản active thắng CV) — READ-ONLY, user tự áp dụng qua UI tuning.',
    nodeId: 'softmax-policy',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'POLICY_ORGAN_TUNING',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' ? 'on' : 'off'
    },
    warning: 'Bật = Brain-C liệt kê đề xuất tham số trong report (không tự áp dụng — KHÔNG ghi TuningParam/TuningChangeLog). Tắt về off = danh sách rỗng — kill-switch độc lập với 2 organ kia.',
    appliesTo: 'buildTuningProposals — report GET /api/brain/policy (src/lib/brain/brains/policy.ts)',
  },
  {
    // BRAIN-UX §9.2 (UX-1) — cờ mở editor kiến trúc trong Brain Studio.
    // Off = chỉ xem (read-only y hệt trước UX-1); on = editor lớp ẩn +
    // lưu nháp BrainSpecDraft. Draft KHÔNG chạm runtime (§9.1-1).
    key: 'ui_brain_edit',
    label: 'UI_BRAIN_EDIT',
    description:
      'Bật/tắt editor kiến trúc não (Brain Studio UX-1): off = panel chỉ xem (an toàn — mặc định); on = chỉnh lớp ẩn/nơ-ron/activation + lưu bản nháp BrainSpecDraft + console train UX-2. Bản nháp KHÔNG bao giờ chạm bản active — đường lên runtime vẫn là train → thắng CV → thăng cấp.',
    nodeId: 'softmax-policy',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'UI_BRAIN_EDIT',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' ? 'on' : 'off'
    },
    appliesTo: 'BrainStudio + TrainingConsole (src/components/database/*) — cờ trình bày, không đụng pipeline',
  },
  {
    // BRAIN-UX §9.4 (UX-3) — cờ hiệu ứng đường dây ánh sáng trên sân khấu não.
    // BRAIN-LIVE (chỉ thị user 2026-10-12): default 'off' → 'on' — tab BRAIN
    // (module Smolab) là "đài quan sát não", hiệu ứng lan truyền là NỘI DUNG
    // CHÍNH không phải trang trí; ui_brain_edit/ui_hitech vẫn giữ 'off'.
    key: 'ui_synapse_fx',
    label: 'UI_SYNAPSE_FX',
    description:
      'Hiệu ứng synapse trên đồ thị não đang chọn (UX-3): off = đường thẳng tĩnh như cũ; on = cạnh bezier gradient + nét đứt chạy theo hướng lan truyền (tiến/ngược) + inspector nơ-ron/cạnh. Mặc định ON theo chỉ thị user 2026-10-12 (tab BRAIN module Smolab là "đài quan sát não" — hiệu ứng là nội dung chính; các tab khác không dùng cờ này). Luôn tôn trọng prefers-reduced-motion (bản tĩnh có mũi tên).',
    nodeId: 'softmax-policy',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'on',
    envKey: 'UI_SYNAPSE_FX',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' ? 'on' : 'off'
    },
    appliesTo: 'BrainStage (src/components/database/brain-stage.tsx) — cờ trình bày, không đụng pipeline',
  },
  {
    // BRAIN-UX §9.6 (UX-5) — cờ theme dark-hi-tech toàn app.
    key: 'ui_hitech',
    label: 'UI_HITECH',
    description:
      'Theme "màn hình kính viền sáng" toàn app (UX-5): off = giao diện hiện tại nguyên vẹn; on = nền sâu #05070D + bề mặt kính mờ + viền sáng chuyển động + nút nhô bóng. Nút bật/tắt nhanh ở thanh bên (localStorage áp dụng tức thì + sync vào đây để audit).',
    nodeId: 'softmax-policy',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'UI_HITECH',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' ? 'on' : 'off'
    },
    appliesTo: 'HiTechToggle (src/components/hitech-toggle.tsx) — nút sidebar + globals.css [data-hitech=on] (CSS-driven toàn cục), không đụng pipeline',
  },
  {
    // BRAIN-UX §9.3 nhóm C — override trọng số composite reward (log-only).
    // DEFAULT = 1/3 mỗi thành phần — TRÙNG REWARD_WEIGHTS (reward.ts, khởi
    // điểm 2026-10-12 khi sweep chưa khả thi — doctrine #1: đổi default CHỈ
    // kèm sweepRewardWeights() đã chạy + chú thích nguồn mới).
    key: 'reward_w_outcome',
    label: 'REWARD_W_OUTCOME (w₁)',
    description:
      'Trọng số w₁ của Outcome* trong composite reward R = w₁·Outcome* + w₂·Efficiency* + w₃·Quality* (đã chuẩn hóa từng thành phần). Chuỗi hiệu lực STORE › ENV › DEFAULT=1/3. Composite reward đang LOG-ONLY (đợt quan sát 1/2) — override KHÔNG đổi quyết định runtime, chỉ đổi số ghi log/report.',
    nodeId: 'softmax-policy',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1 / 3,
    envKey: 'REWARD_W_OUTCOME',
    warning: 'Override chỉ đổi trọng số GHI LOG (log-only) — không tự tham gia quyết định tới khi đủ 2 đợt quan sát (Q1 chốt 2026-10-12).',
    appliesTo: 'resolveRewardWeightsFromTuning (src/lib/brain/reward.ts) — logCompositeRewardForRun + report policy',
  },
  {
    key: 'reward_w_efficiency',
    label: 'REWARD_W_EFFICIENCY (w₂)',
    description:
      'Trọng số w₂ của Efficiency* (tokens so trung vị theo model, kẹp [−1,1]) trong composite reward. Chuỗi hiệu lực STORE › ENV › DEFAULT=1/3. Log-only.',
    nodeId: 'softmax-policy',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1 / 3,
    envKey: 'REWARD_W_EFFICIENCY',
    warning: 'Override chỉ đổi trọng số GHI LOG (log-only) — không tự tham gia quyết định tới khi đủ 2 đợt quan sát.',
    appliesTo: 'resolveRewardWeightsFromTuning (src/lib/brain/reward.ts) — logCompositeRewardForRun + report policy',
  },
  {
    key: 'reward_w_quality',
    label: 'REWARD_W_QUALITY (w₃)',
    description:
      'Trọng số w₃ của Quality* (faithfulness ∈ [0,1]) trong composite reward. Chuỗi hiệu lực STORE › ENV › DEFAULT=1/3. Log-only. Hiện Quality* null trên agent-run (chưa nối EvalResult) — compositeReward renormalize w₁+w₂.',
    nodeId: 'softmax-policy',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1 / 3,
    envKey: 'REWARD_W_QUALITY',
    warning: 'Override chỉ đổi trọng số GHI LOG (log-only) — không tự tham gia quyết định tới khi đủ 2 đợt quan sát.',
    appliesTo: 'resolveRewardWeightsFromTuning (src/lib/brain/reward.ts) — logCompositeRewardForRun + report policy',
  },
  // OBS-P1 (BLUEPRINT-OBSERVATION §C.3 — 4 cờ giao thức quan sát V2, chốt §7
  // Task 23 2026-10-13): toàn bộ off mặc định — check cờ TRƯỚC khi ghi nên
  // overhead bằng 0 khi tắt (C.3). Thứ 26–29 của TUNING_SPECS (PIN UPDATE
  // r86/r87/r92: 25 → 29). Cờ thứ 30 obs_alerts = Task 26-BE (GAP-2 — PIN
  // UPDATE r92: 29 → 30).
  {
    // Cờ tổng ghi sổ cái sự kiện (đợt 1+2 — gate MỌI ghi ObservationEvent +
    // BrainInferenceTrace, C.3). Off = hệ thống quan sát ngủ yên tuyệt đối.
    key: 'obs_ledger',
    label: 'OBS_LEDGER',
    description:
      'Bật sổ cái quan sát (ObservationEvent model 103): ghi mọi sự kiện vận hành — run agent, đổi tuning/flag, brain train, reward log, QEntry/verdict/episode, vết suy diễn não (hash-only). Append-only + prune 50K/30 ngày. Off = overhead 0 (không ghi gì).',
    nodeId: 'hist-feedback',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'OBS_LEDGER',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' || v === '1' || v === 'true' ? 'on' : v === 'off' || v === '0' || v === 'false' ? 'off' : undefined
    },
    appliesTo: 'observeEvent/traceInference (src/lib/observation/) — gate ghi mọi sự kiện',
  },
  {
    // Q2 §7 chốt: hash mặc định — cờ này NÂNG CẤP vết inference lên full
    // vector (điều tra sâu), KHÔNG bật/tắt việc ghi vết (việc đó do obs_ledger).
    key: 'obs_brain_trace',
    label: 'OBS_BRAIN_TRACE',
    description:
      'Nâng vết suy diễn não (BrainInferenceTrace model 104) từ hash-only (mặc định — tiết kiệm) lên LƯU ĐẦY ĐỦ vector input/output (capped 2KB) để điều tra chi tiết. Chỉ có tác dụng khi OBS_LEDGER cũng bật.',
    nodeId: 'hist-feedback',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'OBS_BRAIN_TRACE',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' || v === '1' || v === 'true' ? 'on' : v === 'off' || v === '0' || v === 'false' ? 'off' : undefined
    },
    appliesTo: 'traceInference (src/lib/observation/trace.ts) — lưu inputJson/outputJson đầy đủ',
  },
  {
    // OBS-P4 — job nền impact tracker + obs.health (tick 10 phút).
    key: 'obs_impact',
    label: 'OBS_IMPACT',
    description:
      'Bật job nền ước lượng tác động (impact tracker OBS-P4): với mỗi lần đổi tuning đã ≥ 24h, so sánh KPI snapshot ngày liền trước vs liền sau (tra ±3 ngày mỗi bên) → ghi sự kiện impact.estimate (correlation — KHÔNG claim nhân quả) + obs.health (độ khỏe của chính ledger). Cần obs_ledger on để ghi — obs_ledger off thì tick rỗng (FB-OBS-R1-11).',
    nodeId: 'hist-feedback',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'OBS_IMPACT',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' || v === '1' || v === 'true' ? 'on' : v === 'off' || v === '0' || v === 'false' ? 'off' : undefined
    },
    appliesTo: 'observation impact worker (src/lib/observation/impact.ts) — tick nền',
  },
  {
    // OBS-P3 — cờ trình bày UI quan sát (Task 25: từng là tab console thứ 5
    // › SECTION 3; Task 26: tích hợp vào SECTION 1 selector "Chế độ quan
    // sát" + panel dưới đài SECTION 2 theo chỉ thị user).
    key: 'ui_observation',
    label: 'UI_OBSERVATION',
    description:
      'Bật nội dung quan sát (tab BRAIN › SECTION 1 "Chế độ quan sát" + panel dưới đài SECTION 2): timeline sự kiện live + kim tuyến runId + vết suy luận + hoạt động nơ-ron ("toàn cảnh mỗi khi agent vận hành"). Thuần trình bày — đọc API read-only, không đổi vận hành.',
    nodeId: 'hist-feedback',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'UI_OBSERVATION',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' || v === '1' || v === 'true' ? 'on' : v === 'off' || v === '0' || v === 'false' ? 'off' : undefined
    },
    appliesTo: 'các panel quan sát (src/components/smolab/observation-tab.tsx — render bởi brain-tab SECTION 2 dưới đài, chọn ở SECTION 1) — hiển thị nội dung',
  },
  // Task 26-BE (GAP-2 — GIAO_THUC_GIAM_SAT D1.1/D1.4 + HyperNAS §4.2-2b):
  // cờ thứ 30 của TUNING_SPECS — cùng worker tick 10 phút obs_impact.
  {
    key: 'obs_alerts',
    label: 'OBS_ALERTS',
    description:
      'Bật job nền cảnh báo chủ động trong tick quan sát 10 phút (cùng worker obs_impact): stall run — AgentRunRecord running mà không hoạt động > 15 phút (D1.1) · token-burn — run vừa kết thúc tiêu > 500K tokens (D1.4) · job heartbeat mồ côi — BrainSearchRun running mà heartbeatAt cũ > 30 phút (HyperNAS §4.2-2b) + CronJob nextRunAt quá hạn > 60 phút. Mỗi cảnh báo: console.warn [OBS-ALERT] + sự kiện obs.alert (timeline nhóm Cảnh báo, badge alerts24h). Cần obs_ledger on để GHI sự kiện (off thì vẫn console.warn); tick chỉ chạy khi obs_impact on. Bật/tắt có hiệu lực ngay không restart.',
    nodeId: 'hist-feedback',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'off',
    envKey: 'OBS_ALERTS',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' || v === '1' || v === 'true' ? 'on' : v === 'off' || v === '0' || v === 'false' ? 'off' : undefined
    },
    appliesTo: 'runAlertChecks (src/lib/observation/alerts.ts) — gọi từ tick worker impact.ts',
  },
  // R4-ĐIỀU TRA (lượt 4 — "xưởng nhãn" Brain-A): EvalResult=0 vì eval KB chỉ
  // chạy khi user bấm tay + EvalCase chưa seed → Brain-A "V3" ngủ mãi mãi dù
  // pipeline train + auto-train-after-eval đã sẵn sàng. Cờ thứ 31: tick quan
  // sát 10 phút tự chạy eval NHẸ (8 case) khi nhãn dưới ngưỡng và hết chu kỳ
  // nghỉ — Brain-A thức tỉnh dần theo đúng thiết kế BRAIN-P2.
  {
    key: 'auto_eval_kb',
    label: 'AUTO_EVAL_KB',
    description:
      'Bật xưởng nhãn tự động cho Brain-A "V3" (calibration): trong tick quan sát 10 phút, khi (a) EvalCase active > 0, (b) tổng EvalResult < 60 nhãn, (c) eval gần nhất đã cũ ≥ 12h → chạy eval KB NHẸ (8 case, deepseek NIM — ~1-2 phút) fire-and-forget. Eval runner tự auto-train calibration V2 + V3 (MLP) ngay sau khi đủ ≥ 10 nhãn usable — Brain-A thức tỉnh theo đúng BRAIN-P2 mà không cần user bấm "Chạy đánh giá" tay. Tắt để hoàn toàn thủ công.',
    nodeId: 'hist-feedback',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'on',
    envKey: 'AUTO_EVAL_KB',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' || v === '1' || v === 'true' ? 'on' : v === 'off' || v === '0' || v === 'false' ? 'off' : undefined
    },
    appliesTo: 'maybeRunAutoKbEval (src/lib/eval/auto-eval.ts) — gọi từ tick worker impact.ts',
  },
  // BRAIN-D1 (BLUEPRINT-EVO-NAO-P1-P5 §8.1 — task R20, tái lập sau reset):
  // cờ thứ 32 — LOG-ONLY mọi lượt KB consult (Step-1 retrieval) vào bảng
  // KbConsultLog. Đây là "bộ não quan sát" của Brain-D "Tri Thức": dữ liệu
  // này là ĐIỀU KIỆN thức tỉnh của D2 (baseline ≥100 log) + D3 (policy head
  // ≥300 log có Outcome*). Default ON vì thuần observation — không đổi bất
  // kỳ kết quả trả về nào của pipeline KB (fail-open tuyệt đối: lỗi ghi log
  // không bao giờ làm hỏng truy xuất).
  {
    key: 'kb_consult_log',
    label: 'KB_CONSULT_LOG',
    description:
      'BRAIN-D1 LOG-ONLY: on = mỗi lượt truy xuất KB (searchUserKB — đường chung của chat + agent tools + eval) ghi 1 row KbConsultLog {taskType, intent, cấu hình truy xuất, nguồn + số hit, top-K kết quả, confidence/raw, latency, runId→Outcome*}. Tắt để đo hiệu năng thuần hoặc dừng quan sát — pipeline KB KHÔNG đổi hành vi theo cờ này.',
    nodeId: 'kb-access',
    type: 'enum',
    enumValues: ['off', 'on'],
    default: 'on',
    envKey: 'KB_CONSULT_LOG',
    envMap: raw => {
      const v = raw.trim().toLowerCase()
      return v === 'on' || v === '1' || v === 'true' ? 'on' : v === 'off' || v === '0' || v === 'false' ? 'off' : undefined
    },
    warning: 'Tắt = mất dữ liệu quan sát cho Brain-D (D2/D3 phụ thuộc log tích lũy — ngưng ghi là ngưng tích lũy). Bật lại không khôi phục các lượt đã bỏ sót.',
    appliesTo: 'logKbConsult (src/lib/kb-routing/consult-log.ts) — gọi từ searchUserKB (kb-access.ts); ngữ cảnh từ consult-context.ts ALS',
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
  {
    // BRAIN-D1 (task R20) — node truy xuất KB 4 nguồn (Layer 2 pipeline
    // kb-routing). Nhà của Brain-D "Tri Thức" tương lai (D3 policy head —
    // BLUEPRINT-EVO-NAO §8): hôm nay là điểm đo LOG-ONLY KbConsultLog.
    id: 'kb-access',
    layer: 'processing',
    title: 'KB Routing — Truy xuất 4 nguồn',
    subtitle: 'chunks · entities · memories · communities',
    description:
      'Đường chung của chat + agent tools + eval: searchUserKB chạy 4 nguồn song song (Qdrant chunks + Neo4j entities + AgentMemory + Leiden communities) qua pipeline dense over-fetch → hybrid BM25+RRF → MMR → cross-encoder rerank, kèm calibration confidence (Brain-A). BRAIN-D1 ghi KbConsultLog MỖI lượt (LOG-ONLY, cờ kb_consult_log) — dữ liệu thức tỉnh D2/D3.',
    algorithm: 'confidence = calibrated(raw heuristic) — rawConfidence tách riêng chống feedback-loop',
    algorithmNote: 'Fail-open từng nguồn: 1 nguồn chết → nguồn khác vẫn trả, log ghi kèm errors',
    functions: [
      { name: 'searchUserKB', file: 'src/lib/kb-routing/kb-access.ts' },
      { name: 'logKbConsult (D1)', file: 'src/lib/kb-routing/consult-log.ts' },
      { name: 'runWithKbConsultContext', file: 'src/lib/kb-routing/consult-context.ts' },
    ],
    paramKeys: ['kb_consult_log'],
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
    paramKeys: ['obs_ledger', 'obs_brain_trace', 'obs_impact', 'ui_observation', 'obs_alerts', 'auto_eval_kb'],
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
    paramKeys: ['runtime_model_policy', 'runtime_model_tau', 'replay_eval', 'runtime_policy', 'policy_organ_routing', 'policy_organ_adaptation', 'policy_organ_tuning', 'reward_w_outcome', 'reward_w_efficiency', 'reward_w_quality', 'ui_brain_edit', 'ui_synapse_fx', 'ui_hitech'],
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
  // BRAIN-D1 (task R20) — dòng consult KB: chat + goal-loop hỏi KB, KB đọc
  // qdrant/neo4j, log quan sát ghi về sqlite
  { id: 'e38', from: 'chat', to: 'kb-access', label: 'query → searchUserKB', kind: 'read' },
  { id: 'e39', from: 'goal-loop', to: 'kb-access', label: 'knowledge_search tool', kind: 'read' },
  { id: 'e40', from: 'kb-access', to: 'qdrant', label: 'chunks + communities (đọc)', kind: 'read' },
  { id: 'e41', from: 'kb-access', to: 'neo4j', label: 'entities (đọc)', kind: 'read' },
  { id: 'e42', from: 'kb-access', to: 'sqlite', label: 'KbConsultLog (LOG-ONLY)', kind: 'data' },
]

export const NEURAL_GRAPH: NeuralGraph = {
  layers: [...NEURAL_LAYERS],
  nodes: [...NEURAL_NODES],
  edges: [...NEURAL_EDGES],
}
