/**
 * Agent Activity Log — server-side ring buffer ghi lại MỌI tool call mà
 * agents thực thi (shell, file_edit, run_tests, git_commit...).
 *
 * User request 2026-08-27: "nếu Agents chạy lệnh terminal/shell thì tôi muốn
 * trong ô Terminal thấy rõ được Agents đang sử dụng terminal" — trước đây
 * terminal echo `$ [AI] cmd` chỉ xảy ra khi frontend nhận được SSE event
 * (chế độ Team Code). Single-agent chat (stream:false) không phát event nào
 * → Terminal trống rỗng dù agent đã chạy shell thật.
 *
 * Giải pháp: executeTool() ghi mỗi lần thực thi vào buffer này; Terminal UI
 * poll GET /api/agent-activity?since=<ts> mỗi 2.5s và echo vào ô Terminal —
 * hoạt động ở MỌI chế độ (single chat, team workflow, cron...) bất kể client
 * có stream hay không.
 *
 * In-memory (không DB) — đủ cho mục đích hiển thị realtime, tự giới hạn
 * kích thước (ring buffer 300 entries).
 *
 * Task 20-b (self-monitoring): MỖI entry ghi vào ring buffer cũng được persist
 * vào bảng ToolMetric (SQLite) qua recordToolMetric() — fire-and-forget,
 * fail-open. Đây là choke-point DUY NHẤT mà mọi tool execution chảy qua
 * (executeTool() là caller duy nhất hiện tại) → mọi tool call hiện lên
 * Terminal feed cũng land vào ToolMetric 1:1, sống sót qua restart. Mọi entry
 * của buffer này THEO HỢP ĐỒNG là 1 tool execution thật (không có event non-tool).
 */

import { recordToolMetric } from '@/lib/tool-metrics-recorder'

export interface AgentActivityEntry {
  id: string
  /** Thời điểm thực thi (epoch ms) */
  ts: number
  /** Tên agent thực thi (VD: "Omega", "CATALYST") — "" nếu không biết */
  agentName: string
  /** Tên tool (VD: "shell", "file_edit") */
  tool: string
  /** Mô tả ngắn: lệnh shell / đường dẫn file / action */
  detail: string
  success: boolean
  durationMs: number
  /** Chat/workflow session id (nếu có) */
  sessionId?: string | null
  /**
   * KẾT QUẢ THẬT của tool (stdout/stderr, content preview...) — truncated.
   * User request 2026-08-31: Terminal phải hiện cả lệnh LẪN kết quả chạy
   * thật để nhận biết kết quả thực tế chứ không phải giả.
   */
  resultPreview?: string
  /**
   * TASK 41 (fix "[FileSelect] read failed: /home/z/.tmo-harness/task-1.txt"):
   * Đường dẫn TUYỆT ĐỐI server-resolved của file mà tool vừa thao tác (file_read/
   * file_edit/file_write/file_delete/file_multi_edit/opencode read-write).
   * `detail` giữ nguyên path RAW như agent truyền (thường TƯƠNG ĐỐI — VD
   * ".tmo-harness/task-1.txt") → client phải ĐOÁN abs path bằng workspaceRoot
   * trong localStorage, mà localStorage có thể LỆCH với workspace root thật của
   * server (DB active workspace → OPENCODE_WORKSPACE → cwd). Đoán sai → auto-open
   * tab đọc path không tồn tại → 404 + console error + toast đỏ.
   * Server là source of truth: ghi abs path ĐÃ RESOLVE đúng theo workspace root
   * mà tool thực thi. Client ưu tiên field này (fallback: đoán như cũ).
   */
  path?: string
}

const MAX_ENTRIES = 300
const MAX_RESULT_PREVIEW = 900

const globalForActivity = globalThis as unknown as {
  __tmoAgentActivityLog?: AgentActivityEntry[]
}

function buffer(): AgentActivityEntry[] {
  if (!globalForActivity.__tmoAgentActivityLog) {
    globalForActivity.__tmoAgentActivityLog = []
  }
  return globalForActivity.__tmoAgentActivityLog
}

let seq = 0

/**
 * Ghi 1 activity entry. Không bao giờ throw (fail-open — hiển thị activity
 * không được phép làm hỏng tool execution).
 */
export function recordAgentActivity(entry: {
  agentName?: string
  tool: string
  detail?: string
  success: boolean
  durationMs: number
  sessionId?: string | null
  resultPreview?: string
  /** TASK 41 — abs path server-resolved (file tools) — xem comment ở interface */
  path?: string
}): AgentActivityEntry {
  const buf = buffer()
  const recorded: AgentActivityEntry = {
    id: `act_${Date.now()}_${++seq}`,
    ts: Date.now(),
    agentName: (entry.agentName || '').slice(0, 40),
    tool: String(entry.tool || '').slice(0, 40),
    detail: String(entry.detail || '').slice(0, 300),
    success: !!entry.success,
    durationMs: Math.max(0, Math.round(entry.durationMs || 0)),
    sessionId: entry.sessionId || null,
    resultPreview: entry.resultPreview
      ? String(entry.resultPreview).slice(0, MAX_RESULT_PREVIEW)
      : undefined,
    path: entry.path ? String(entry.path).slice(0, 500) : undefined,
  }
  buf.push(recorded)
  if (buf.length > MAX_ENTRIES) {
    buf.splice(0, buf.length - MAX_ENTRIES)
  }

  // Task 20-b — persist ToolMetric (fire-and-forget, fail-open bên trong;
  // khi tool FAIL thì resultPreview chứa message lỗi → errorTag dòng đầu).
  recordToolMetric({
    toolName: recorded.tool,
    sessionId: recorded.sessionId,
    agentRole: recorded.agentName,
    success: recorded.success,
    durationMs: recorded.durationMs,
    error: recorded.success ? undefined : recorded.resultPreview,
  })

  return recorded
}

/**
 * Lấy các entry mới hơn `sinceTs` (epoch ms). Trả về tối đa `limit` entry
 * (mặc định 50) theo thứ tự thời gian tăng dần.
 */
export function getAgentActivity(sinceTs = 0, limit = 50): AgentActivityEntry[] {
  const buf = buffer()
  const out = buf.filter(e => e.ts > sinceTs)
  return out.slice(-limit)
}
