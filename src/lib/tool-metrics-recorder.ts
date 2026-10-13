/**
 * Tool Metrics Recorder — persist MỖI tool execution vào bảng ToolMetric (SQLite).
 *
 * Task 20-b (self-monitoring). Trước đây tool calls chỉ được ghi vào ring buffer
 * in-memory (agent-activity-log.ts — 300 entries, mất khi restart) → KHÔNG có
 * tool success rate thật. Model ToolMetric đã có trong schema từ Phase 3 nhưng
 * CHƯA BAO GIỜ được ghi ("phantom wired").
 *
 * Choke-point: recordAgentActivity() (agent-activity-log.ts) — NƠI DUY NHẤT mọi
 * tool execution chảy qua trên đường tới Terminal feed (executeTool() là caller
 * duy nhất, che cả single chat ReAct + Code Team + cron). Bất kỳ tool call nào
 * hiện lên Terminal cũng land vào ToolMetric — 1:1.
 *
 * Fail-open TUYỆT ĐỐI: fire-and-forget (không await ở caller), mọi lỗi DB bị nuốt
 * (`.catch(() => {})`) — metrics KHÔNG BAO GIỜ làm fail tool execution.
 */

import { db, withSqliteRetry } from '@/lib/db'

/** Độ dài tối đa errorTag (dòng đầu message lỗi)
 *  2026-09-26 FIX (Tool health audit): 64 → 200. Trước đây cắt sớm khiến mất
 *  thông tin chẩn đoán quan trọng — VD "Access denied: path escapes workspace
 *  root (/home/z/" bị cụt ngay trước phần PATH vi phạm (không biết agent đã
 *  thử đọc file nào), "File not found: src/lib/agent-goal-loo" mất đuôi file. */
const ERROR_TAG_MAX = 200

/**
 * Rút errorTag từ message lỗi: dòng đầu, trim, cắt ERROR_TAG_MAX ký tự.
 * VD: "Error: ENOENT: no such file or directory, open '/x/y'\n  at ..." →
 *     "Error: ENOENT: no such file or directory, open '/x/y'"
 */
export function toErrorTag(error: unknown): string | null {
  try {
    if (error === null || error === undefined) return null
    const msg =
      typeof error === 'string'
        ? error
        : error instanceof Error
          ? error.message
          : (() => {
              try {
                return JSON.stringify(error)
              } catch {
                return String(error)
              }
            })()
    if (!msg) return null
    const firstLine = String(msg).split('\n')[0]?.trim() || ''
    if (!firstLine) return null
    return firstLine.slice(0, ERROR_TAG_MAX)
  } catch {
    return null
  }
}

/**
 * Ghi 1 ToolMetric row — fire-and-forget, KHÔNG bao giờ throw.
 *
 * @param params.toolName    Tên tool (shell, file_edit, run_tests...)
 * @param params.sessionId   Chat/workflow session id ('unknown' nếu thiếu —
 *                           schema ToolMetric yêu cầu NOT NULL)
 * @param params.agentRole   Agent thực thi (agentName — Omega/CATALYST/TL...;
 *                           'unknown' nếu thiếu)
 * @param params.success     Tool thành công?
 * @param params.durationMs  Wall-clock duration (ms)
 * @param params.error       Error/result lỗi (success=false) → errorTag dòng đầu
 */
export function recordToolMetric(params: {
  toolName: string
  sessionId?: string | null
  agentRole?: string | null
  success: boolean
  durationMs: number
  error?: unknown
}): void {
  try {
    const toolName = String(params.toolName || '').slice(0, 120).trim()
    if (!toolName) return
    // db (instance chính) đã có delegate toolMetric từ Phase 3 — an toàn với
    // cả instance stale (xem metrics-db.ts cho bridge AgentRunRecord)
    //
    // Task 33 (§0b lượt 2): withSqliteRetry — đo thật 19:1x cụm ghi run-close
    // làm toolMetric.create dính "Socket timeout" (dev.log ~49500) → metric
    // mất vĩnh viễn (fail-open nuốt). Retry chỉ chạy lại khi query chưa kịp
    // execute (đứng trong pool queue — P1008) — trường hợp hiếm commit-mà-
    // mất-response chấp nhận duplicate 1 row (tốt hơn mất metric).
    void withSqliteRetry(
      () => db.toolMetric.create({
        data: {
          toolName,
          sessionId: (params.sessionId || 'unknown').slice(0, 120),
          agentRole: (params.agentRole || 'unknown').slice(0, 60),
          success: !!params.success,
          exitCode: params.success ? 0 : 1,
          durationMs: Math.max(0, Math.round(params.durationMs || 0)),
          errorTag: params.success ? null : toErrorTag(params.error),
        },
      }),
      { label: `toolMetric.create(${toolName})` },
    ).catch(() => {
      /* fail-open — metrics không được phép crash hay block tool exec */
    })
  } catch {
    /* fail-open */
  }
}
