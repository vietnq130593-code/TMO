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
import { enqueueWriteFireAndForget } from '@/lib/db-write-batcher'

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
    const sessionId = (params.sessionId || 'unknown').slice(0, 120)
    const agentRole = (params.agentRole || 'unknown').slice(0, 60)
    const errorTag = params.success ? null : toErrorTag(params.error)
    // W1/S2 audit #1 (BLUEPRINT-R17BC v0.2 — bảng §4.2): toolMetric.create qua
    // WriteBatcher. OFF = pass-through identical (withSqliteRetry do batcher nắm,
    // P1-2); ON = op gom vào batch 1 tx — chống "Socket timeout" cụm run-close
    // (đo thật Task 33 :83: metric mất vĩnh viễn khi fail-open nuốt; idempotency:
    // hiếm commit-mà-mất-response chấp nhận duplicate 1 row — giữ nguyên hợp đồng
    // :84-86). Fail-open tuyệt đối: fire-and-forget KHÔNG throw — metrics không
    // được phép crash hay block tool exec (giữ nguyên catch-im-lặng :103-105 →
    // giờ là bg-catch debt/DEVlog trong batcher).
    enqueueWriteFireAndForget(
      {
        kind: 'create',
        model: 'toolMetric',
        data: {
          toolName,
          sessionId,
          agentRole,
          success: !!params.success,
          exitCode: params.success ? 0 : 1,
          durationMs: Math.max(0, Math.round(params.durationMs || 0)),
          errorTag,
        },
      },
      { label: `toolMetric.create(${toolName})` },
    )
    // R17 (QUAN-SAT lượt 7 · 6.1c) — ĐƯỜNG GHI NỢ THỨ 4 "crash-proof" cho
    // tool-failure lặp: cùng tool fail ≥3 lần CÙNG session → ghi nợ infra
    // NGAY, không đợi arbiter (bằng chứng R16 V2.3: 'shell' ×5 "/bin/bash:
    // sqlite3: command not found" + 'db_query' ×3 — hiển thị ngay Tool health
    // panel nhưng DebtLedger 0 dòng). Mỗi lần fail mới (4th, 5th...) đếm lại
    // ≥3 → recordDebtIssue gọi lại → bump recurrence (đúng N2 — tái xuất
    // hiện là tín hiệu hệ thống). Fingerprint của issue chứa errorTag nên 2
    // "họ lỗi" khác nhau của cùng tool = 2 nợ riêng. Fail-open tuyệt đối.
    if (!params.success) {
      void withSqliteRetry(
        () => db.toolMetric.count({ where: { sessionId, toolName, success: false } }),
        { label: `toolMetric.count(${toolName})` },
      )
        .then(failCount => {
          if (failCount < 3) return
          void import('@/lib/execution/debt-ledger')
            .then(({ recordDebtIssue }) => recordDebtIssue({
              issue: `Tool ${toolName} thất bại lặp ≥3 lần cùng session — ${errorTag ?? 'không có errorTag'}`,
              kind: 'infra',
              sessionId: sessionId === 'unknown' ? null : sessionId,
              evidence: `ToolMetric ${toolName} (agent ${agentRole}): ${failCount} fail cùng session · errorTag=${errorTag ?? '(trống)'}`,
            }))
            .catch(() => { /* fail-open — ghi nợ không được phép crash metric */ })
        })
        .catch(() => { /* fail-open — pattern check không được phép crash */ })
    }
  } catch {
    /* fail-open */
  }
}
