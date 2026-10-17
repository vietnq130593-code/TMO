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
import { getKbConsultContext } from '@/lib/kb-routing/consult-context'

/** Giới hạn JSON field (byte UTF-8 — truncate + flag). */
const MAX_QUERY_TEXT_BYTES = 2_000
const MAX_CONFIG_JSON_BYTES = 2_000
const MAX_SOURCES_JSON_BYTES = 2_000
const MAX_RESULTS_JSON_BYTES = 4_000

/** Đuôi đánh dấu queryText bị cắt (byte UTF-8: '…' 3B + '[truncated]' 11B). */
const QUERY_TRUNCATE_SUFFIX = '…[truncated]'

/**
 * Độ dài byte UTF-8 của chuỗi — FB-D1-R1-03: cap theo BYTE như cam kết
 * blueprint §8.1/schema comment. So theo `.length` (UTF-16 code units)
 * làm guarantee "≤2KB/≤4KB" sai 2-4× với tiếng Việt/emoji (1 char có thể
 * 2-4 byte UTF-8). Fail-open: Buffer không có → đếm chars (đủ dùng).
 */
function byteLen(s: string): number {
  try {
    return Buffer.byteLength(s, 'utf8')
  } catch {
    return s.length
  }
}

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

/** JSON.stringify an toàn + truncate kèm flag truncated:true (không bao giờ throw).
 * Mọi phép so giới hạn theo BYTE UTF-8 (FB-D1-R1-03). */
function serializeCapped(value: unknown, maxBytes: number): string {
  try {
    let json = JSON.stringify(value)
    if (json === undefined) return '{}'
    if (byteLen(json) <= maxBytes) return json
    // Truncate theo object khi có thể: topResults cắt bớt phần tử đầu còn
    // vừa thì giữ nguyên thứ tự quan trọng nhất (top-1 đứng đầu)
    if (Array.isArray(value)) {
      const arr = value as unknown[]
      for (let keep = arr.length - 1; keep >= 1; keep--) {
        const candidate = JSON.stringify([...arr.slice(0, keep), { truncated: true, dropped: arr.length - keep }])
        if (candidate !== undefined && byteLen(candidate) <= maxBytes) return candidate
      }
      return JSON.stringify({ truncated: true, dropped: arr.length })
    }
    // Ngân sách quá nhỏ cho object flag — trả flag tối thiểu (≤19B)
    if (maxBytes < 40) return JSON.stringify({ truncated: true })
    // Object thường: cắt phần đầu theo byte an toàn ranh giới ký tự + flag.
    // Giảm 10%/vòng từ full length — guarantee ≤ maxBytes trong O(log n) vòng
    // (mỗi char UTF-8 ≤4 byte nên không cắt sâu hơn mức cần quá 10%).
    const headBudgetBytes = maxBytes - 60
    let keepChars = json.length
    let head = ''
    while (keepChars > 0) {
      head = json.slice(0, keepChars)
      if (byteLen(head) <= headBudgetBytes) break
      keepChars = Math.floor(keepChars * 0.9)
    }
    if (byteLen(head) > headBudgetBytes) head = '' // phòng thủ budget 0
    return JSON.stringify({ truncated: true, head })
  } catch {
    return '{}'
  }
}

/** Query text rút gọn an toàn — theo BYTE UTF-8, ranh giới ký tự (FB-D1-R1-03/08). */
function capQueryText(q: string | undefined | null): string | undefined {
  // FB-D1-R1-08 — phân biệt "KHÔNG có query" (null/undefined → NULL trong DB)
  // với "query rỗng" ('' → ''): lượt consult query-trống là dữ liệu thật.
  if (q === undefined || q === null) return undefined
  if (byteLen(q) <= MAX_QUERY_TEXT_BYTES) return q
  // FB-D1-R1-03 — cắt theo byte, không cắt giữa multi-byte char / surrogate
  // pair: for..of duyệt theo code point, tích luỹ byte từng ký tự.
  const budget = MAX_QUERY_TEXT_BYTES - byteLen(QUERY_TRUNCATE_SUFFIX)
  let used = 0
  let cut = 0
  for (const ch of q) {
    const b = byteLen(ch)
    if (used + b > budget) break
    used += b
    cut += ch.length
  }
  return q.slice(0, cut) + QUERY_TRUNCATE_SUFFIX
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

/**
 * BRAIN-D1 (FB-D1-R1-05) — row cho lượt consult rơi vào FALLBACK dense-only:
 * knowledge-bridge.agentKnowledgeSearch bắt lỗi searchUserKB throw (throw xảy
 * ra TRƯỚC khi instrumentation cuối hàm searchUserKB kịp chạy) → nếu không
 * ghi ở đây thì lượt đó KHÔNG có row nào — phá guarantee "MỌI lượt KB consult
 * đều được ghi" (blueprint §8.1). Kết quả chi tiết của fallback (hits/
 * minScore) nằm ở diagnostics trả về agent — ngoài corpus D1-v1.
 *
 * NEVER THROWS (logKbConsult + getKbConsultContext đều fail-open) — caller
 * (nhánh catch của agentKnowledgeSearch) gọi fire-and-forget được.
 */
export async function logKbConsultFallback(
  query: string | undefined,
  startedAtMs: number,
  pipelineError: unknown
): Promise<void> {
  const ctx = getKbConsultContext()
  await logKbConsult({
    taskType: ctx.taskType ?? 'kb-fallback-dense',
    intent: ctx.intent,
    queryText: query,
    retrievalConfig: { fallbackDenseOnly: true },
    sources: {
      pipelineError: (
        pipelineError instanceof Error ? pipelineError.message : String(pipelineError)
      ).slice(0, 200),
    },
    topResults: [],
    latencyMs: Math.max(0, Date.now() - startedAtMs),
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
  })
}
