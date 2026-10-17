/**
 * agent-status — ánh xạ trạng thái 5 mức cho pill badge agent (PURE, không UI).
 * =============================================================================
 * Nguồn chuẩn: docs/AGENT-STATUS-DISPLAY-STANDARD.md (31-g) — "CHUẨN TRÌNH BÀY
 * TRẠNG THÁI AGENT — MÀN HÌNH HỘI THOẠI". Hàm `mapToAgentStatus` là hiện thuần
 * (pure) của §1 "Nghĩa và tiêu chí chuyển trạng thái" — nhận dữ liệu THẬT có
 * sẵn phía Smolab chat header và trả về đúng 1 trong 5 trạng thái.
 *
 * Năm trạng thái (doc §1) — mỗi trạng thái trả lời: "người dùng gửi tin nhắn
 * tiếp theo thì có được phản hồi không, và mất bao lâu?":
 *   - ACTIVE  — kết nối sống, không có run đang chạy, sẵn sàng nhận yêu cầu.
 *   - IDLE    — chưa từng kết nối, hoặc kết nối đã đóng sạch (mặc định mở màn hình).
 *   - BUSY    — có run đang thực thi (streaming token, gọi tool…).
 *   - ERROR   — run gần nhất thất bại và chưa có run mới thành công.
 *   - OFFLINE — mất kết nối ngoài ý muốn (mạng rớt, agent tắt, hết phiên).
 *
 * Ánh xạ nguồn dữ liệu thật của app TMO (trung thực — không bịa tín hiệu):
 *   - Trục run (BUSY/ERROR): danh sách run của PHIÊN hiện tại từ
 *     /api/agent-run (agent-run-tracker — status 'running'|'done'|'error'|
 *     'cancelled', gồm cả run tái tạo từ AgentRunRecord) + cờ fetch chat
 *     đang chờ (chatInFlight = isLoading của header).
 *   - Trục kết nối (ACTIVE/IDLE/OFFLINE): /api/openclaw/status (health gateway
 *     thụ động, poll 15s) — `gatewayOnline` + `lastSeenOnline` (timestamp lần
 *     cuối gateway trả lời ok).
 *
 * Ghi chú phái sinh OFFLINE (doc §1 không đưa ngưỡng số; app có thiết kế thật
 * để suy ra — openclaw-ondemand Task 9: gateway idle-shutdown sau
 * OPENCLAW_IDLE_SHUTDOWN_MS mặc định 10 PHÚT không dùng đến, health check
 * thụ động không giữ gateway sống):
 *   OFFLINE ⇔ gateway KHÔNG online
 *          VÀ không có tin nhắn đang chờ (chatInFlight — gateway on-demand có
 *              thể đang spawn hợp pháp → coi là BUSY, không phải mất kết nối)
 *          VÀ từng thấy gateway online (lastSeenOnline ≠ null — "từng có kết
 *              nối"; chưa từng thấy → IDLE "chưa từng kết nối")
 *          VÀ phiên còn hoạt động gần đây (< AGENT_OFFLINE_GRACE_MS = đúng
 *              cửa sổ idle-shutdown 10' — quá ngưỡng này thì việc gateway tắt
 *              là kết quả đóng sạch THEO THIẾT KẾ → IDLE)
 *          VÀ gateway từng được thấy sống trong/dấu hoạt động gần nhất của
 *              phiên (lastSeenOnline ≥ hoạt động cuối − AGENT_SEEN_SLACK_MS)
 *              — loại false-positive khi run/provider riêng không qua gateway
 *              (chat agent có provider/model riêng — xem openclaw.ts).
 *
 * Thứ tự ưu tiên (doc §1, nguyên văn): "OFFLINE và ERROR là trạng thái chặn,
 * ghi đè BUSY. BUSY ghi đè ACTIVE và IDLE. Còn lại thì ưu tiên kết nối: có
 * kết nối thì ACTIVE, không thì IDLE. Không để xảy ra hai nhãn cùng lúc."
 *
 * Diễn giải trung thực hai lối thoát ERROR (doc §1: "Hết trạng thái này khi
 * người dùng gửi tin nhắn mới (chuyển BUSY) hoặc kết nối lại thành công"):
 *   - Thoát 1 (gửi tin nhắn mới → BUSY): triển khai ĐẦY ĐỦ — chatInFlight
 *     hoặc run mới hơn (running/done) làm ERROR tắt.
 *   - Thoát 2 (kết nối lại → ACTIVE/IDLE): KHÔNG tự động — app không phân biệt
 *     được run lỗi do mất kết nối hay lỗi nghiệp vụ thật (không có dữ liệu
 *     nguyên nhân) → giữ ERROR đến khi có run mới, tránh che giấu thất bại
 *     thật của lần chạy gần nhất.
 */

/** 5 trạng thái chuẩn (doc §1) — không bao giờ hiển thị hai nhãn cùng lúc. */
export type AgentPillStatus = 'ACTIVE' | 'IDLE' | 'BUSY' | 'ERROR' | 'OFFLINE'

/**
 * Ngưỡng phái sinh OFFLINE = cửa sổ idle-shutdown của gateway on-demand
 * (openclaw-ondemand: OPENCLAW_IDLE_SHUTDOWN_MS mặc định 10 phút). Hoạt động
 * của phiên cũ hơn ngưỡng này → gateway tắt là "đóng sạch theo thiết kế" (IDLE).
 */
export const AGENT_OFFLINE_GRACE_MS = 10 * 60 * 1000

/**
 * Dung sai khi đối chiếu "gateway từng sống trong/dấu hoạt động gần nhất của
 * phiên": nhịp poll health 15s + lệch clock client/server.
 */
export const AGENT_SEEN_SLACK_MS = 30 * 1000

/** Run tối thiểu cần cho ánh xạ — cấu trúc con của AgentRunData (smolab-module)
 * (status chuẩn agent-run-tracker: 'running' | 'done' | 'error' | 'cancelled';
 * recordRuns từ DB đã được /api/agent-run map về đúng bộ này). */
export interface AgentRunStatusLite {
  status: string
  startedAt: number
  endedAt?: number
}

/** Đầu vào ánh xạ — toàn bộ dữ liệu THẬT có sẵn ở Smolab chat header. */
export interface AgentStatusInput {
  /** Các run của phiên hiện tại (Object.values(agentRuns) trong smolab-module). */
  runs?: AgentRunStatusLite[]
  /** Client vừa gửi tin nhắn đang chờ phản hồi (isLoading) — "run bắt đầu". */
  chatInFlight?: boolean
  /** Gateway (/api/openclaw/status) đang trả lời /health ok — "kết nối sống". */
  gatewayOnline: boolean
  /** Timestamp (epoch ms) lần cuối gateway online — null = chưa từng thấy. */
  lastSeenOnline?: number | null
  /** Thời điểm hiện tại (epoch ms) — inject để test biên; mặc định Date.now(). */
  now?: number
}

/**
 * Pure map → 1 trong 5 trạng thái theo doc §1 (xem đầu file cho chuẩn từng
 * nhánh + thứ tự ưu tiên). Không đụng DOM, không Date.now khi truyền `now`.
 */
export function mapToAgentStatus(input: AgentStatusInput): AgentPillStatus {
  const now = input.now ?? Date.now()
  const runs = input.runs ?? []
  const chatInFlight = !!input.chatInFlight

  // — Run gần nhất theo startedAt (dự phòng endedAt làm tie-break) —
  let latestRun: AgentRunStatusLite | null = null
  let lastRunActivityMs: number | null = null
  for (const r of runs) {
    if (!r || typeof r.startedAt !== 'number') continue
    const act = typeof r.endedAt === 'number' ? r.endedAt : r.startedAt
    if (lastRunActivityMs === null || act > lastRunActivityMs) lastRunActivityMs = act
    if (
      !latestRun ||
      r.startedAt > latestRun.startedAt ||
      (r.startedAt === latestRun.startedAt && (r.endedAt ?? 0) > (latestRun.endedAt ?? 0))
    ) {
      latestRun = r
    }
  }
  const hasRunningRun = runs.some(r => r?.status === 'running')

  // ERROR (doc §1): run GẦN NHẤT kết thúc lỗi + chưa có run mới thành công
  // (run mới hơn làm latestRun đổi) + chưa có tin nhắn mới (thoát → BUSY).
  // Run 'cancelled' là user chủ động dừng — KHÔNG tính là lỗi.
  const errorActive = latestRun?.status === 'error' && !chatInFlight

  // OFFLINE (phái sinh — xem đầu file): mất kết nối ngoài ý muốn.
  const offline =
    !input.gatewayOnline &&
    !chatInFlight &&
    input.lastSeenOnline != null &&
    lastRunActivityMs != null &&
    now - lastRunActivityMs < AGENT_OFFLINE_GRACE_MS &&
    input.lastSeenOnline >= lastRunActivityMs - AGENT_SEEN_SLACK_MS

  // Ưu tiên doc §1: OFFLINE/ERROR chặn > BUSY > trục kết nối (ACTIVE/IDLE).
  if (offline) return 'OFFLINE'
  if (errorActive) return 'ERROR'
  if (chatInFlight || hasRunningRun) return 'BUSY'
  return input.gatewayOnline ? 'ACTIVE' : 'IDLE'
}

// ==================== Hiển thị chuẩn (doc §2, §3, §4) ====================
// Đặt ở lib (không phải component) để test pin được chuỗi verbatim theo doc.

/** Nhãn tiếng Việt Title Case (doc §3) — dùng khi đủ rộng. */
export const AGENT_STATUS_LABELS: Record<AgentPillStatus, string> = {
  ACTIVE: 'Đang hoạt động',
  IDLE: 'Đang rảnh',
  BUSY: 'Đang bận',
  ERROR: 'Lỗi',
  OFFLINE: 'Ngoại tuyến',
}

/** Nhãn rút gọn khi header quá hẹp (doc §3: giữ icon + nhãn ngắn). */
export const AGENT_STATUS_SHORT_LABELS: Record<AgentPillStatus, string> = {
  ACTIVE: 'Hoạt động',
  IDLE: 'Rảnh',
  BUSY: 'Bận',
  ERROR: 'Lỗi',
  OFFLINE: 'Ngoại tuyến',
}

/** Tooltip chuẩn (doc §4) — verbatim. */
export const AGENT_STATUS_TOOLTIPS: Record<AgentPillStatus, string> = {
  ACTIVE: 'Agent đang kết nối và sẵn sàng phản hồi.',
  IDLE: 'Agent đang kết nối và chờ yêu cầu mới.',
  BUSY: 'Agent đang xử lý yêu cầu, phản hồi có thể bị chậm.',
  ERROR: 'Lần xử lý gần nhất gặp lỗi. Gửi tin nhắn mới để thử lại.',
  OFFLINE: 'Không liên lạc được với agent. Kiểm tra mạng hoặc khởi động lại agent.',
}

/** Hình dạng icon theo trạng thái (doc §2 — màu không phải tín hiệu duy nhất). */
export type AgentStatusIcon =
  | 'check-circle-filled' // ACTIVE — dấu tích tròn đặc
  | 'circle-hollow' // IDLE — vòng tròn rỗng
  | 'spinner' // BUSY — mũi tên xoay / spinner
  | 'warning-triangle' // ERROR — dấu chấm than trong tam giác
  | 'circle-slash' // OFFLINE — đường kẻ chéo tròn

/**
 * Bảng màu chuẩn (doc §2) — hex VERBATIM theo bảng trong doc; mọi tổ hợp
 * chữ/nền đạt WCAG AA. `text` = màu chữ nhãn; `bg` = nền thân pill;
 * `border` = viền pill 1px VÀ màu icon (quy ước doc §2: "màu viền dùng cho
 * chấm trạng thái 8px và đường viền pill 1px").
 */
export const AGENT_STATUS_VISUALS: Record<
  AgentPillStatus,
  { text: string; bg: string; border: string; icon: AgentStatusIcon }
> = {
  ACTIVE: { text: '#15803D', bg: '#DCFCE7', border: '#22C55E', icon: 'check-circle-filled' },
  IDLE: { text: '#475569', bg: '#F1F5F9', border: '#94A3B8', icon: 'circle-hollow' },
  BUSY: { text: '#92400E', bg: '#FEF3C7', border: '#F59E0B', icon: 'spinner' },
  ERROR: { text: '#991B1B', bg: '#FEE2E2', border: '#EF4444', icon: 'warning-triangle' },
  OFFLINE: { text: '#374151', bg: '#E5E7EB', border: '#6B7280', icon: 'circle-slash' },
}
