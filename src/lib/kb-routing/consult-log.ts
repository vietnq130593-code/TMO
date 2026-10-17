/**
 * BRAIN-D1 (BLUEPRINT-EVO-NAO-P1-P5 §8.1 — task R20) — KB CONSULT LOG WRITER
 * ============================================================================
 *
 * Ghi row KbConsultLog cho MỖI lượt Step-1 retrieval (searchUserKB).
 * LOG-ONLY: KHÔNG chặn, KHÔNG đổi kết quả trả về — mọi nhánh fail-open:
 *   - cờ `kb_consult_log` = off (tuning-store STORE > ENV > DEFAULT 'on')
 *     → skip im lặng;
 *   - DB lỗi/prisma chưa generate → warn throttle 60s, KHÔNG throw lên
 *     đường retrieval (triết lý fail-open của toàn learning side-channel —
 *     precedent tuning-store.ts);
 *   - JSON field vượt giới hạn → truncate + flag truncated:true
 *     (precedent AuditEvent overflow).
 *
 * Dữ liệu này là "bộ não quan sát" cho Brain-D "Tri Thức":
 *   D2 (baseline đối chứng) cần ≥100 log; D3 (policy head 3 tầng) cần
 *   ≥300 log có Outcome* (runId nối AgentRunRecord).
 */

import { db } from '@/lib/db'
import { getTuningEnum } from '@/lib/learning/tuning-store'

/** Giới hạn JSON field (byte UTF-8 — truncate + flag). */
const MAX_QUERY_TEXT_BYTES = 2_000
const MAX_CONFIG_JSON_BYTES = 2_000
const MAX_SOURCES_JSON_BYTES = 2_000
const MAX_RESULTS_JSON_BYTES = 4_000

/** Warn throttle — DB down dài hạn không spam dev.log (precedent tuning-store). */
const globalForConsultLog = globalThis as unknown as {
  __tmoKbConsultLogWarnedAt?: number
}

/** Dữ liệu 1 lượt consult — searchUserKB tổng hợp rồi gọi logKbConsult. */
export interface KbConsultLogEntry {
  taskType?: string
  intent?: string
  queryText?: string
  /** Object cấu hình — sẽ JSON.stringify + truncate trong đây */
  retrievalConfig: Record<string, unknown>
  /** Object nguồn + số hit — sẽ JSON.stringify + truncate trong đây */
  sources: Record<string, unknown>
  /** Top-K rút gọn — sẽ JSON.stringify + truncate trong đây */
  topResults: Array<Record<string, unknown>>
  confidence?: number
  rawConfidence?: number
  tokensUsed?: number
  latencyMs: number
  runId?: string
  sessionId?: string
  agentId?: string
}

/** JSON.stringify an toàn + truncate kèm flag truncated:true (không bao giờ throw). */
function serializeCapped(value: unknown, maxBytes: number): string {
  try {
    let json = JSON.stringify(value)
    if (json === undefined) return '{}'
    if (json.length <= maxBytes) return json
    // Truncate theo object khi có thể: topResults cắt bớt phần tử đầu còn
    // vừa thì giữ nguyên thứ tự quan trọng nhất (top-1 đứng đầu)
    if (Array.isArray(value)) {
      const arr = value as unknown[]
      for (let keep = arr.length - 1; keep >= 1; keep--) {
        const candidate = JSON.stringify([...arr.slice(0, keep), { truncated: true, dropped: arr.length - keep }])
        if (candidate !== undefined && candidate.length <= maxBytes) return candidate
      }
      return JSON.stringify({ truncated: true, dropped: arr.length })
    }
    // Object thường: cắt chuỗi + flag
    return JSON.stringify({ truncated: true, head: json.slice(0, Math.max(0, maxBytes - 60)) })
  } catch {
    return '{}'
  }
}

/** Query text rút gọn an toàn. */
function capQueryText(q: string | undefined): string | undefined {
  if (!q) return undefined
  return q.length <= MAX_QUERY_TEXT_BYTES ? q : q.slice(0, MAX_QUERY_TEXT_BYTES) + '…[truncated]'
}

/** Cờ bật logging — STORE > ENV > DEFAULT 'on' (fail-open: lỗi đọc cờ = mặc định on). */
function isConsultLogEnabled(): boolean {
  try {
    return getTuningEnum('kb_consult_log') === 'on'
  } catch {
    return true
  }
}

/**
 * Ghi 1 row KbConsultLog — NEVER THROWS (caller fire-and-forget được).
 * Trả về Promise chỉ để caller muốn await (test); production KHÔNG await.
 */
export async function logKbConsult(entry: KbConsultLogEntry): Promise<void> {
  try {
    if (!isConsultLogEnabled()) return

    await db.kbConsultLog.create({
      data: {
        taskType: entry.taskType ?? null,
        intent: entry.intent ?? null,
        queryText: capQueryText(entry.queryText),
        retrievalConfigJson: serializeCapped(entry.retrievalConfig, MAX_CONFIG_JSON_BYTES),
        sourcesJson: serializeCapped(entry.sources, MAX_SOURCES_JSON_BYTES),
        topResultsJson: serializeCapped(entry.topResults, MAX_RESULTS_JSON_BYTES),
        confidence: entry.confidence ?? null,
        rawConfidence: entry.rawConfidence ?? null,
        tokensUsed: entry.tokensUsed ?? 0,
        latencyMs: Math.max(0, Math.round(entry.latencyMs)),
        runId: entry.runId ?? null,
        sessionId: entry.sessionId ?? null,
        agentId: entry.agentId ?? null,
      },
    })
  } catch (err) {
    const now = Date.now()
    const g = globalForConsultLog
    if (!g.__tmoKbConsultLogWarnedAt || now - g.__tmoKbConsultLogWarnedAt > 60_000) {
      g.__tmoKbConsultLogWarnedAt = now
      console.warn(
        '[KbConsultLog] ghi log thất bại (fail-open — truy xuất KB KHÔNG ảnh hưởng):',
        err instanceof Error ? err.message : String(err)
      )
    }
  }
}
