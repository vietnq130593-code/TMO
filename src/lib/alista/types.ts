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
  /** Target string dùng làm key phụ cho dedupe (vd 'grep', 'BOLT', 'embed') */
  target: string
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
