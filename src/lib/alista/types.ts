/**
 * ALISTA — Shared Types (v1.1)
 * ============================
 * Kỹ sư Bảo trì Hệ thống TMO — ca 23h30 hàng ngày, budget 6h, pipeline tuần tự.
 *
 * File này định nghĩa toàn bộ type dùng chung cho module alista (collectors,
 * rules, proposals, comprehensive-check, scheduler). KHÔNG import side-effect —
 * chỉ type thuần, an toàn import từ bất kỳ đâu.
 */

/** Số thứ tự nhiệm vụ (1-7) — phải khớp với STEP_LABELS / COLLECTORS index */
export type CheckId = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** Trigger nguồn khởi động pipeline — manual (nút UI) hoặc cron-nightly (23h30) */
export type CheckTrigger = 'manual' | 'cron-nightly'

/** Kết quả 1 collector chạy — fail-open: lỗi → ok=false + error, không throw */
export interface CollectorResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** Thời gian collect (ms) — để StepEntry hiển thị */
  collectMs?: number
}

/**
 * 1 finding = 1 phát hiện có vấn đề từ rules (deterministic).
 * Truyền vào proposals.ts để LLM viết thành 4 phần proposal.
 */
export interface Finding {
  /** Dedupe key — `[ALISTA] <check>:<target>:<yyyymm>` (vd `[ALISTA] tool:grep:202609`) */
  key: string
  /** Check ID 1-7 */
  checkId: CheckId
  /** Label hiển thị (StepEntry.label) */
  checkLabel: string
  /** Self-Direction category — đã validate trong VALID_CATEGORIES */
  category: string
  /** low | medium | high | critical */
  priority: string
  /** Số liệu thô làm chứng cứ (object tuỳ ý) */
  evidence: Record<string, unknown>
  /** Gợi ý giải pháp ngắn cho LLM phát triển thành văn proposal */
  direction: string
  /** Target string dùng làm key phụ cho dedupe (vd 'grep', 'RAMPAGE', 'embed') */
  target: string
  /**
   * (v1.3) Tiêu chí xác nhận hiệu quả giải pháp — cấu trúc, machine-checkable.
   * Rule đi kèm metric + ngưỡng target + cửa sổ re-check: verify loop dùng
   * recheckAfterMs để quyết định đo lại NGAY hay HOÃN đến khi metric kịp
   * phản ánh giải pháp (chống false-negative "CHƯA triệt để" sai).
   */
  successCriteria?: SuccessCriteria
}

/** (v1.3) Tiêu chí xác nhận hiệu quả 1 giải pháp — gắn với Finding */
export interface SuccessCriteria {
  /** Tên metric (vd 'tool "grep" successRate cửa sổ 7d') */
  metric: string
  /** Giá trị hiện tại lúc phát hiện (số hoặc chuỗi mô tả) */
  current: string | number
  /** Ngưỡng mục tiêu coi là đã giải quyết */
  target: string | number
  /** Toán tử so sánh với target */
  operator: 'gte' | 'lte' | 'eq'
  /** Chờ bao lâu (ms) sau khi proposal hoàn tất trước khi đo lại — 0 = đo ngay */
  recheckAfterMs: number
  /** Lý do (tiếng Việt) vì sao cần chờ — hiển thị cho owner */
  recheckWhy: string
}

// ==================== RECHECK WINDOW (v1.3) ====================
//
// Sau khi 1 proposal được phê duyệt + xử lý hoàn tất, verify loop re-run collector.
// Nhưng nhiều metric cần THỜI GIAN để phản ánh giải pháp (successRate tính trên
// cửa sổ 7 ngày chứa lỗi cũ; entity count cần nạp tài liệu; backlog cần review...).
// Verify NGAY → false-negative "CHƯA triệt để" → follow-up spam.
//
// Map dưới là nguồn SỰ THẬT DUY NHẤT (single source of truth) cho recheck window:
//   - rules.ts đọc khi build successCriteria (đưa vào proposal text)
//   - proposal-verify.ts đọc khi quyết định verify NGAY (0) hay HOÃN (dueAt)
//
// Key: slug mặc định | override `slug:target`.

const HOUR = 3600_000
const DAY = 24 * HOUR

/** Recheck window mặc định theo slug (slug = phần thứ 2 trong dedupe key) */
export const RECHECK_DEFAULTS_MS: Record<string, number> = {
  tool: 3 * DAY, // successRate cửa sổ 7d — ~3 ngày để lỗi cũ rơi khỏi cửa sổ
  run: 1 * DAY, // cần run kế tiếp của agent xác nhận pattern không tái diễn
  zombie: 0, // dọn zombie có hiệu lực tức thời
  escalation: 1 * DAY, // occurrence/resolved cần thời gian ghi nhận
  domain: 7 * DAY, // nạp tài liệu + extraction cần nhiều giờ/ngày
  layer: 0, // connectivity đo tức thời (override cho các target cần thời gian)
  self: 0, // không re-check được (guard sẵn ở verify)
  db: 1 * DAY,
}

/** Override recheck window cho slug:target cụ thể */
export const RECHECK_TARGET_OVERRIDES_MS: Record<string, number> = {
  // ⑤ layer — target cần thời gian phản ánh
  'layer:qdrant_empty': 1 * DAY, // re-embed backfill cần chạy
  'layer:embed_low': 3 * DAY, // re-embed + tỷ lệ cần tích lũy
  'layer:neo4j_drop': 1 * DAY, // restore/sync
  'layer:qdrant_drop': 1 * DAY, // re-embed collection
  'layer:disk': 1 * DAY, // archival/vacuum cần chạy
  // ⑦ db — target cụ thể
  'db:schema_drift': 0,
  'db:zombies': 0,
  'db:mirror_episode_drift': 2 * DAY, // backfill mirror cần chạy
  'db:mirror_lesson_drift': 2 * DAY,
  'db:autolearn_pending_stuck': 1 * HOUR, // restart worker là nhanh
  'db:autolearn_failures': 1 * DAY,
  'db:writeback_backlog': 2 * DAY, // review thủ công từng mục
  'db:lessons_review_backlog': 2 * DAY,
  'db:kg_unsynced': 1 * DAY, // sync catch-up
  'db:kg_buffer_overload': 1 * DAY,
  'db:token_spike': 3 * DAY, // pattern tiêu thụ cần ngày để bình thường hoá
  'db:token_drop': 3 * DAY,
  'db:db_size': 2 * DAY, // archival + VACUUM
  'db:large_tables': 2 * DAY,
  'db:cron_stuck': 1 * HOUR, // scheduler self-heal qua tick 60s
  'db:queue_stuck': 6 * HOUR,
  'db:queue_backlog': 1 * DAY,
  'db:queue_failures': 1 * DAY,
}

/** Lý do con người đọc được — đi kèm window khi hoãn verify */
export const RECHECK_WHY: Record<string, string> = {
  tool: 'successRate đo trên cửa sổ 7 ngày — cần ~3 ngày để các lần gọi lỗi cũ rơi khỏi cửa sổ',
  run: 'cần run kế tiếp của agent để xác nhận pattern fail không tái diễn',
  escalation: 'số occurrence/resolution cần thời gian để hệ thống ghi nhận đủ',
  domain: 'nạp tài liệu + pipeline extraction cần nhiều giờ đến nhiều ngày',
  'layer:qdrant_empty': 'pipeline re-embed backfill cần thời gian chạy',
  'layer:embed_low': 're-embed + tích lũy tỷ lệ embedding thật cần ~3 ngày',
  'layer:disk': 'archival/vacuum/dọn file cần thời gian chạy',
  'db:mirror_episode_drift': 'backfill mirror từ graph cần thời gian chạy',
  'db:mirror_lesson_drift': 'backfill mirror từ graph cần thời gian chạy',
  'db:writeback_backlog': 'review từng writeback là việc thủ công — cần thời gian',
  'db:lessons_review_backlog': 'review từng lesson là việc thủ công — cần thời gian',
  'db:token_spike': 'pattern tiêu thụ token cần vài ngày để bình thường hoá',
  'db:token_drop': 'pattern tiêu thụ token cần vài ngày để bình thường hoá',
  'db:cron_stuck': 'scheduler self-heal qua tick 60s — 1 giờ là đủ kết luận',
}

/** Tra recheck window + lý do cho 1 finding (slug + target) */
export function recheckWindowFor(slug: string, target: string): { ms: number; why: string } {
  const overrideKey = `${slug}:${target.toLowerCase()}`
  const ms = RECHECK_TARGET_OVERRIDES_MS[overrideKey] ?? RECHECK_DEFAULTS_MS[slug] ?? 0
  const why = RECHECK_WHY[overrideKey] ?? RECHECK_WHY[slug] ?? 'metric phản ánh tức thời — đo lại ngay'
  return { ms, why }
}

/** Input tạo proposal (đã qua validateProposalInput) */
export interface ProposalInput {
  key: string
  category: string
  priority: string
  problem: string
  solution: string
  implementation: string
  impact: string | null
  scheduleAt: Date | null
  /** llm | code-workflow — CI-6 B5 (classifyExecutionMode từ scan.ts) */
  executionMode?: 'llm' | 'code-workflow'
}

/** 1 proposal đã tạo (hoặc skip do dedupe) */
export interface CreatedProposal {
  id: string
  title: string
  /** true nếu tạo mới; false nếu skip do đã có đề xuất còn sống */
  created: boolean
  skipReason?: string
}

/** Trạng thái 1 bước trong pipeline tuần tự */
export type StepStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped'

/** Entry 1 bước trong pipeline — đẩy vào globalState Map để UI poll */
export interface StepEntry {
  id: CheckId
  label: string
  icon: string
  status: StepStatus
  startedAt: number
  durationMs?: number
  collectMs?: number
  /** Snapshot dữ liệu thu thập (fail-open — {ok,error,data}) */
  collected?: { ok: boolean; error?: string; data?: unknown }
  findings?: Finding[]
  proposalsCreated?: Array<{ id: string; title: string }>
  proposalCount?: number
  /** Error message khi status='failed' */
  error?: string
  /** Lý do skip khi status='skipped' hoặc 'partial' */
  skipReason?: string
}

/** Kết quả tổng của 1 lần chạy pipeline */
export interface CheckResult {
  /** UUID của lần chạy */
  checkId: string
  trigger: CheckTrigger
  startedAt: number
  completedAt?: number
  durationMs?: number
  /** Deadline cứng (epoch ms) */
  deadlineMs: number
  /** true nếu pipeline hoàn tất trước deadline; false nếu bị cắt ngang */
  deadlineMet: boolean
  status: 'running' | 'completed' | 'failed'
  steps: StepEntry[]
  /** Toàn bộ proposal đã tạo trong lần chạy */
  proposalsCreated: Array<{ id: string; title: string }>
  /** Các bước bị skip do trượt deadline */
  partialSteps: Array<{ step: number; label: string; reason: string }>
  /** 'all_checks_done' | 'budget_exhausted' | 'error' */
  reason: string
  error?: string
}

/** Label + icon cố định cho 7 bước — dùng trong StepEntry + UI poll */
export const STEP_LABELS: Record<CheckId, string> = {
  1: 'Tools health',
  2: 'Agent runs',
  3: 'Escalations',
  4: 'Domain coverage',
  5: '3 tầng dữ liệu',
  6: 'Tự-đánh-giá ALISTA',
  7: 'Database + Memory + Learning',
}

export const STEP_ICONS: Record<CheckId, string> = {
  1: '🔧',
  2: '🤖',
  3: '🚨',
  4: '📊',
  5: '🗄️',
  6: '🛡️',
  7: '💾',
}

/** Lấy chuỗi YYYY-MM-DD 'hôm nay' theo giờ VN (Asia/Ho_Chi_Minh) */
export function vnDateStr(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

/** Cộng/trừ số ngày trên chuỗi YYYY-MM-DD (UTC-safe string math) */
export function shiftDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Helper tạo key dedupe — `[ALISTA] <check>:<target>:<yyyymm>` (yyyymm theo giờ VN) */
export function makeDedupeKey(checkSlug: string, target: string, date = new Date()): string {
  // FIX v1.2: yyyymm theo giờ VN (trước đây UTC → lệch 7h ở ranh giới tháng);
  // dùng vnDateStr tách phần year/month để không lệ thuộc đồng hồ server UTC.
  const [y, m] = vnDateStr(date).split('-')
  const yyyymm = `${y}${m}`
  const safeTarget = target.toLowerCase().replace(/\s+/g, '_').slice(0, 40)
  return `[ALISTA] ${checkSlug}:${safeTarget}:${yyyymm}`
}

/**
 * Strip hậu tố follow-up `:v<N>` khỏi key → base key.
 * Dùng cho dedupe: proposal `[ALISTA] db:x:202609` và follow-up `...:202609:v2`
 * là CÙNG một vấn đề — base key dùng làm prefix khớp title.
 */
export function baseKeyOf(key: string): string {
  return key.replace(/:v\d+$/, '')
}
