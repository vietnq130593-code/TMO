/**
 * BRAIN-D2 (BLUEPRINT-EVO-NAO-P1-P5 §8.2 — task 31-d) — PURE STATS HELPERS
 * ============================================================================
 *
 * Toán thuần cho script baseline đối chứng D2 (scripts/d2-baseline-report.ts):
 * heuristic CỨNG hiện tại (pipeline 4 lớp cố định kb-routing) đạt mức nào trên
 * KbConsultLog THẬT — phân phối latency theo intent, tỷ lệ nguồn trúng (nguồn
 * tắt vs trống vs lỗi — sourcesEnabled), tương quan kết quả↔Outcome*.
 *
 * Doctrine #9 (single-source): module THUẦN — 0 import db/server/React →
 * client-safe + bun:test trực tiếp (precedent evo/ui-helpers.ts r115).
 * Mọi hàm DETERMINISTIC: không Math.random, không Date.now (thời gian chỉ
 * xuất hiện ở caller — generatedAt của script). Fail-open: parser nhận garbage
 * → trả TYPED null, KHÔNG throw (precedent safeCount / parseTrainMeta trong
 * src/app/api/brain/route.ts).
 *
 * Ngưỡng nghĩa (§8.1): D2 bắt đầu "có dữ liệu" ≥100 log; D3 cần ≥300 log có
 * Outcome*. Bộ số liệu từ helpers này là snapshot đối chứng cho gate A1 của D3.
 */

// ==================== TYPES ====================

/** Tóm tắt phân phối latency (latencyMs — chiều hiệu năng CHÍNH của D1-v1 vì
 * tokensUsed luôn 0, API embed/rerank chưa trả usage — R21 chốt). */
export interface LatencySummary {
  n: number
  p50: number | null
  p95: number | null
  mean: number | null
  max: number | null
}

/** Kết cục 1 nguồn truy xuất trong 1 lượt consult:
 *  - 'hit'                — nguồn bật, có ≥1 kết quả;
 *  - 'empty'              — nguồn bật, 0 kết quả, không lỗi (KB trống/thiếu match);
 *  - 'error'              — nguồn lỗi (sourcesJson.errors[source] — allSettled rejected);
 *  - 'disabled'           — nguồn TẮT qua sourcesEnabled, 0 hit (bỏ chạy chủ đích);
 *  - 'hit-while-disabled' — BẤT THƯỜNG: nguồn tắt nhưng vẫn có hits (không nên
 *                           xảy ra — flag để D2/D3 soi regression cấu hình). */
export type SourceOutcome = 'hit' | 'empty' | 'error' | 'disabled' | 'hit-while-disabled'

/** Shape sourcesJson sau parse fail-open (writer: kb-access.ts / knowledge-bridge.ts
 * / consult-log.ts logKbConsultFallback). Row searchUserKB: {chunks, entities,
 * memories, communities, errors?} · row graph-query: {graphRecords, graphError?}
 * · row fallback: {pipelineError}. */
export interface SourcesPayload {
  chunks?: number
  entities?: number
  memories?: number
  communities?: number
  errors?: Record<string, string>
  graphRecords?: number
  graphError?: string
  pipelineError?: string
  /** Flag truncate của serializeCapped (consult-log.ts) — giữ nguyên để caller
   * biết dữ liệu có thể bị cắt. */
  truncated?: boolean
}

/** sourcesEnabled trong retrievalConfigJson — nguồn nào ĐƯỢC PHÉP chạy (vd
 * entities/memories tắt khi caller không truyền agentId — kb-access.ts). */
export interface SourcesEnabled {
  chunks?: boolean
  communities?: boolean
  entities?: boolean
  memories?: boolean
}

/** Shape retrievalConfigJson sau parse fail-open (§8.1 bảng trường). */
export interface RetrievalConfigPayload {
  topK?: number
  minImportance?: number
  embeddingOverride?: boolean
  hybrid?: boolean
  mmr?: boolean
  rerank?: boolean
  /** Tham số truy xuất DUY NHẤT biến thiên theo thời gian (red-team delta). */
  denseThreshold?: number
  sourcesEnabled?: SourcesEnabled
  graphCypher?: boolean
  fallbackDenseOnly?: boolean
  truncated?: boolean
}

/** 1 cặp (metric, Outcome*) cho tương quan Pearson — Outcome* theo reward.ts:
 * 1 = run thành công (complete / status completed), 0 = còn lại. */
export interface OutcomePair {
  metric: number
  outcomeSuccess: boolean
}

/** Kết quả tương quan — null khi KHÔNG tính được (n<3 hoặc variance 0):
 * trung thực hơn là trả số rác. */
export interface CorrelationResult {
  n: number
  pearsonR: number
}

// ==================== PERCENTILE / MEAN / MEDIAN ====================

/**
 * Percentile p (0..100) của mảng ĐÃ SẮP XUẤNG TĂNG — nội suy TUYẾN TÍNH
 * chuẩn (rank = p/100 × (n−1), chặn giữa 2 phần tử lân cận). KHÔNG tự sort
 * (caller giữ quyền — summarizeLatency sort sẵn; median sort trong copy).
 *
 * Fail-open: mảng rỗng hoặc p không hợp lệ (NaN/∞/ngoài [0,100]) → null.
 * Ví dụ pin (test r117): [1..100] p95 → 95.05; [1,2,3,4] p50 → 2.5.
 */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null
  if (!Number.isFinite(p) || p < 0 || p > 100) return null
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]
  const frac = rank - lo
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac
}

/** Trung bình cộng — mảng rỗng → null (không bịa 0). */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/** Trung vị — sort BẢN COPY bên trong (không đổi mảng gốc — thuần, không tác dụng phụ). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return percentile(sorted, 50)
}

/**
 * Tóm tắt phân phối latency: {n, p50, p95, mean, max} (§8.2 "phân phối latency
 * theo intent"). Lọc giá trị non-finite (NaN/∞ — phòng dữ liệu bẩn) TRƯỚC khi
 * thống kê; n đếm SAU lọc (trung thực về cỡ mẫu thật).
 */
export function summarizeLatency(values: readonly number[]): LatencySummary {
  const finite = values.filter(v => Number.isFinite(v))
  if (finite.length === 0) {
    return { n: 0, p50: null, p95: null, mean: null, max: null }
  }
  const sorted = [...finite].sort((a, b) => a - b)
  return {
    n: finite.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: mean(finite),
    max: sorted[sorted.length - 1],
  }
}

// ==================== FAIL-OPEN JSON PARSERS ====================

/** JSON.parse → object thường, còn lại (throw / array / primitive / rỗng) → null. */
function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/** Lấy number finite — không hợp lệ → undefined (fail-open từng trường). */
function finiteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Lấy boolean — không hợp lệ → undefined. */
function booleanOrUndefined(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

/** Lấy string — không hợp lệ → undefined. */
function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/**
 * Parse sourcesJson (KbConsultLog) — fail-open TYPED NULL trên garbage:
 * chuỗi rỗng / JSON hỏng / array / primitive / object KHÔNG có key nào quen
 * thuộc → null (caller bỏ qua row đó ở section nguồn, KHÔNG sập report).
 * Chấp nhận cả object truncate {truncated:true} của serializeCapped.
 */
export function parseSourcesJson(raw: string | null | undefined): SourcesPayload | null {
  const obj = parseJsonObject(raw)
  if (!obj) return null
  const knownKeys = [
    'chunks', 'entities', 'memories', 'communities', 'errors',
    'graphRecords', 'graphError', 'pipelineError', 'truncated',
  ]
  if (!knownKeys.some(k => k in obj)) return null

  let errors: Record<string, string> | undefined
  if (obj.errors && typeof obj.errors === 'object' && !Array.isArray(obj.errors)) {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(obj.errors as Record<string, unknown>)) {
      if (typeof v === 'string') clean[k] = v
    }
    if (Object.keys(clean).length > 0) errors = clean
  }

  return {
    chunks: finiteNumber(obj.chunks),
    entities: finiteNumber(obj.entities),
    memories: finiteNumber(obj.memories),
    communities: finiteNumber(obj.communities),
    errors,
    graphRecords: finiteNumber(obj.graphRecords),
    graphError: stringOrUndefined(obj.graphError),
    pipelineError: stringOrUndefined(obj.pipelineError),
    truncated: booleanOrUndefined(obj.truncated),
  }
}

/**
 * Parse retrievalConfigJson (KbConsultLog) — cùng quy tắc fail-open như
 * parseSourcesJson. Row graph-query chỉ có {graphCypher:true}; row fallback
 * chỉ có {fallbackDenseOnly:true} — cả hai đều hợp lệ.
 */
export function parseRetrievalConfig(raw: string | null | undefined): RetrievalConfigPayload | null {
  const obj = parseJsonObject(raw)
  if (!obj) return null
  const knownKeys = [
    'topK', 'minImportance', 'embeddingOverride', 'hybrid', 'mmr', 'rerank',
    'denseThreshold', 'sourcesEnabled', 'graphCypher', 'fallbackDenseOnly', 'truncated',
  ]
  if (!knownKeys.some(k => k in obj)) return null

  let sourcesEnabled: SourcesEnabled | undefined
  if (obj.sourcesEnabled && typeof obj.sourcesEnabled === 'object' && !Array.isArray(obj.sourcesEnabled)) {
    const se = obj.sourcesEnabled as Record<string, unknown>
    sourcesEnabled = {
      chunks: booleanOrUndefined(se.chunks),
      communities: booleanOrUndefined(se.communities),
      entities: booleanOrUndefined(se.entities),
      memories: booleanOrUndefined(se.memories),
    }
  }

  return {
    topK: finiteNumber(obj.topK),
    minImportance: finiteNumber(obj.minImportance),
    embeddingOverride: booleanOrUndefined(obj.embeddingOverride),
    hybrid: booleanOrUndefined(obj.hybrid),
    mmr: booleanOrUndefined(obj.mmr),
    rerank: booleanOrUndefined(obj.rerank),
    denseThreshold: finiteNumber(obj.denseThreshold),
    sourcesEnabled,
    graphCypher: booleanOrUndefined(obj.graphCypher),
    fallbackDenseOnly: booleanOrUndefined(obj.fallbackDenseOnly),
    truncated: booleanOrUndefined(obj.truncated),
  }
}

// ==================== SOURCE OUTCOME ====================

/**
 * Phân loại kết cục 1 nguồn trong 1 lượt consult (§8.2 "tỷ lệ nguồn trúng —
 * kể cả nguồn tắt vs trống vs lỗi"). THỨ TỰ ƯU TIÊN tất định:
 *   1. error (string lỗi từ sourcesJson.errors) — lỗi thắng mọi nhánh để NHẦN
 *      rõ nhất (nguồn chết là tín hiệu quan trọng nhất cho D3 fail-open);
 *   2. nguồn TẮT (sourcesEnabled=false): hits>0 → 'hit-while-disabled' (bất
 *      thường — không nên xảy ra), ngược lại → 'disabled' (bỏ chạy chủ đích,
 *      KHÔNG phải lỗi);
 *   3. hits>0 → 'hit'; còn lại → 'empty' (nguồn chạy, KB không có gì).
 *
 * enabled undefined (row cũ không có sourcesEnabled / nguồn ngoài 4 nguồn
 * chuẩn) → coi như ĐANG BẬT (nguồn có mặt trong sourcesJson là đã chạy).
 * hits undefined → 0. error '' → không coi là lỗi.
 */
export function classifySourceOutcome(
  enabled: boolean | undefined,
  hits: number | undefined,
  error: string | undefined,
): SourceOutcome {
  if (error !== undefined && error !== '') return 'error'
  const isEnabled = enabled ?? true
  const h = typeof hits === 'number' && hits > 0 ? hits : 0
  if (!isEnabled) return h > 0 ? 'hit-while-disabled' : 'disabled'
  return h > 0 ? 'hit' : 'empty'
}

// ==================== PEARSON CORRELATION ====================

/**
 * Tương quan Pearson r giữa metric (latency/confidence/total hits…) và
 * Outcome* (0/1) — §8.2 "tương quan kết quả↔Outcome*".
 *
 * Fail-open null khi:
 *   - n<3 (sau khi lọc metric non-finite) — quá mỏng để nói gì;
 *   - variance X hoặc Y = 0 (metric không đổi, hoặc Outcome toàn một loại) —
 *     r vô nghĩa/0 chia 0;
 *   - kết quả non-finite sau tính (phòng số cực đoan).
 * r được kẹp [−1,1] chống trôi floating-point (|r| có thể 1+1e−16 trên dữ
 * liệu perfectly-correlated).
 *
 * Ví dụ pin (test r117): [(1,F),(2,F),(3,T),(4,T)] → r = 2/√5 ≈ 0.8944;
 * [(1,F),(1,F),(2,T),(2,T)] → r = +1.
 */
export function correlateOutcome(pairs: readonly OutcomePair[]): CorrelationResult | null {
  const clean = pairs.filter(p => Number.isFinite(p.metric))
  const n = clean.length
  if (n < 3) return null

  const xs = clean.map(p => p.metric)
  const ys = clean.map(p => (p.outcomeSuccess ? 1 : 0))
  const mx = mean(xs)
  const my = mean(ys)
  if (mx === null || my === null) return null

  let cov = 0
  let varX = 0
  let varY = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    cov += dx * dy
    varX += dx * dx
    varY += dy * dy
  }
  if (varX === 0 || varY === 0) return null

  const denominator = Math.sqrt(varX * varY)
  if (denominator === 0 || !Number.isFinite(denominator)) return null
  const r = cov / denominator
  if (!Number.isFinite(r)) return null
  return { n, pearsonR: Math.max(-1, Math.min(1, r)) }
}
