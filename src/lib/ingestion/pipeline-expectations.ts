/**
 * P5-M4 — DATA-QUALITY EXPECTATIONS CHO PIPELINE INGESTION
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P5-M4, mục #12 — DA.pdf §Data Quality,
 * Orchestration & Monitoring — Great Expectations-style)
 *
 * Lớp expectation KHAI BÁO TẬP TRUNG + ngưỡng tỷ lệ cho pipeline ingestion —
 * hiện trạng đã có guard rời rạc (chunk count, zero-vector, extract giả) nhưng
 * thiếu: (1) nơi khai báo tập trung mọi ngưỡng chất lượng dữ liệu, (2) ngưỡng
 * TỶ LỆ (entity-rate — hallucination detector), (3) cảnh báo xu hướng.
 *
 * Triết lý (spec §P5-M4): KHÔNG chặn pipeline mới — chỉ PHÂN LOẠI CẢNH BÁO:
 *   - severity 'fail'  → caller giữ Document ở 'partial' (đúng cơ chế hiện có
 *     của P0-5 guard — pipeline có thể chạy lại để tự chữa)
 *   - severity 'warn'  → ghi vào Document.processingSteps[].detail + đếm vào
 *     KPI ingestion_expectation_fails (kpi/registry)
 *
 * Ngưỡng khởi điểm (spec §P5-M4 — mọi hằng số kèm nguồn, hiệu chỉnh theo dữ
 * liệu thật qua KPI/dashboard):
 *   - chunks_per_page  ∈ [0.3, 8]   (warn) — quá ít = parse hỏng, quá nhiều = chunking lỗi
 *   - entity_rate      ∈ [0.2, 6]/chunk (warn) — extraction hallucinating hoặc miss
 *   - zero_vector_rate < 0.01       (fail) — đã có guard riêng P0-5, nâng thành expectation thống kê
 *   - relationship_per_entity ∈ [0.2, 4] (warn)
 *   - embedding_success_rate > 0.999 (fail)
 *
 * Thuần hàm — KHÔNG I/O; điểm gọi duy nhất: cuối pipeline (trước khi set
 * 'indexed') trong src/app/api/ingestion/process/route.ts.
 */

export interface PipelineExpectation {
  id: string
  step: string
  metric: string
  op: 'gt' | 'lt' | 'between'
  bound: number | [number, number]
  severity: 'warn' | 'fail'
  note: string
}

export const PIPELINE_EXPECTATIONS: PipelineExpectation[] = [
  {
    id: 'chunks_per_page',
    step: 'chunk',
    metric: 'chunks_per_page',
    op: 'between',
    // spec §P5-M4: [0.3, 8] — dưới 0.3 trang gần như không chia được (parse
    // hỏng); trên 8 chunk/trang = chunking lỗi (chunk quá mảnh)
    bound: [0.3, 8],
    severity: 'warn',
    note: 'quá ít = parse hỏng, quá nhiều = chunking lỗi',
  },
  {
    id: 'entity_rate',
    step: 'extract',
    metric: 'entity_rate',
    op: 'between',
    // spec §P5-M4: [0.2, 6] entity/chunk — dưới 0.2 = miss (extract không
    // bắt được gì), trên 6 = hallucinating (LLM đẻ entity ảo hàng loạt)
    bound: [0.2, 6],
    severity: 'warn',
    note: 'extraction hallucinating hoặc miss',
  },
  {
    id: 'zero_vector_rate',
    step: 'embeddings',
    metric: 'zero_vector_rate',
    op: 'lt',
    // spec §P5-M4: < 0.01 (fail) — guard P0-5 đã chặn zero-vector ở mức
    // "còn bất kỳ chunk zero" (mức cứng); expectation này nâng lên phiên bản
    // TỶ LỆ để bắt xu hướng hỏng một phần (vd 3% chunk lỗi = sắp hỏng lớn)
    bound: 0.01,
    severity: 'fail',
    note: 'đã có guard riêng (P0-5), nâng thành expectation thống kê',
  },
  {
    id: 'relationship_per_entity',
    step: 'extract',
    metric: 'relationship_per_entity',
    op: 'between',
    // spec §P5-M4: [0.2, 4] — dưới 0.2 = extract relation miss; trên 4 =
    // relation giả (một entity đẻ cả chục cạnh vô nghĩa)
    bound: [0.2, 4],
    severity: 'warn',
    note: 'relationship extraction thiếu/thừa',
  },
  {
    id: 'embedding_success_rate',
    step: 'embeddings',
    metric: 'embedding_success_rate',
    op: 'gt',
    // spec §P5-M4: > 0.999 (fail) — lỗi embed ở mức tỷ lệ: 1 lỗi/1000 chunk
    // là ngưỡng provider lỗi thật (lỗi đơn lẻ do retry đã được che ở batch)
    bound: 0.999,
    severity: 'fail',
    note: 'provider embedding lỗi hàng loạt',
  },
]

export interface ExpectationResult {
  id: string
  /** metric có đo được và đã kiểm ngưỡng chưa (false = thiếu số đo) */
  evaluated: boolean
  passed: boolean
  severity: 'warn' | 'fail'
  value: number
  /** mô tả người đọc được — vào processingSteps detail + log */
  detail: string
}

/**
 * Kiểm một giá trị theo một expectation (thuần). NaN không qua được phép nào —
 * caller truyền số đo hữu hạn; thiếu số đo → expectation.evaluated=false.
 */
function checkBound(value: number, op: PipelineExpectation['op'], bound: number | [number, number]): boolean {
  if (op === 'gt') return value > (bound as number)
  if (op === 'lt') return value < (bound as number)
  const [lo, hi] = bound as [number, number]
  return value >= lo && value <= hi
}

function formatBound(op: PipelineExpectation['op'], bound: number | [number, number]): string {
  if (op === 'gt') return `> ${bound}`
  if (op === 'lt') return `< ${bound}`
  const [lo, hi] = bound as [number, number]
  return `∈ [${lo}, ${hi}]`
}

/**
 * Đánh giá TẤT CẢ expectation khai báo trong PIPELINE_EXPECTATIONS theo bản đồ
 * số đo `measurements` (metric → giá trị). Metric thiếu / NaN / ±∞ → kết quả
 * evaluated=false (KHÔNG tính là vi phạm — thiếu số đo không có nghĩa là hỏng;
 * caller ghi nhận trong summary để đường nhìn thấy méo mó dữ liệu).
 */
export function evaluateExpectations(measurements: Record<string, number>): ExpectationResult[] {
  return PIPELINE_EXPECTATIONS.map(exp => {
    const raw = measurements[exp.metric]
    const value = typeof raw === 'number' ? raw : Number.NaN
    if (!Number.isFinite(value)) {
      return {
        id: exp.id,
        evaluated: false,
        passed: true,
        severity: exp.severity,
        value: Number.NaN,
        detail: `${exp.id}: chưa đo được (thiếu số đo) — bỏ qua, không tính vi phạm`,
      }
    }
    const passed = checkBound(value, exp.op, exp.bound)
    return {
      id: exp.id,
      evaluated: true,
      passed,
      severity: exp.severity,
      value,
      detail: passed
        ? `${exp.id} = ${round4(value)} ${formatBound(exp.op, exp.bound)} ✓`
        : `${exp.id} = ${round4(value)} NGOÀI ${formatBound(exp.op, exp.bound)} (${exp.severity.toUpperCase()}: ${exp.note})`,
    }
  })
}

export interface ExpectationSummary {
  /** số expectation vi phạm mức fail (đã đo) */
  failCount: number
  /** số expectation vi phạm mức warn (đã đo) */
  warnCount: number
  /** số expectation không đo được */
  notMeasured: number
  /** dòng người đọc được cho processingSteps detail + log */
  line: string
  /**
   * Marker máy đọc được — KPI ingestion_expectation_fails quét chuỗi này trong
   * Document.processingSteps (regex: /expectations\[P5-M4\]: fail=(\d+) warn=(\d+)/)
   */
  marker: string
}

const MARKER_RE = /expectations\[P5-M4\]: fail=\d+ warn=\d+(?: · .*)?/

/** Rút gọn 4 chữ số thập phân cho dòng detail. */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}

/**
 * Tóm tắt kết quả cho điểm gọi pipeline: đếm vi phạm theo mức + dựng dòng
 * detail (kèm marker máy-đọc-được cho KPI) + strip marker cũ nếu ghép lại.
 */
export function summarizeExpectationResults(results: ExpectationResult[]): ExpectationSummary {
  const violations = results.filter(r => r.evaluated && !r.passed)
  const failCount = violations.filter(r => r.severity === 'fail').length
  const warnCount = violations.filter(r => r.severity === 'warn').length
  const notMeasured = results.filter(r => !r.evaluated).length

  const violationText = violations.length > 0 ? violations.map(r => r.detail).join(' · ') : 'all pass'
  const notMeasuredText = notMeasured > 0 ? ` · chưa đo: ${notMeasured}` : ''
  const line = `expectations[P5-M4]: fail=${failCount} warn=${warnCount} · ${violationText}${notMeasuredText}`
  return { failCount, warnCount, notMeasured, line, marker: line }
}

/** Bỏ marker P5-M4 cũ khỏi một chuỗi detail (idempotent khi pipeline ghi đè). */
export function stripExpectationMarker(detail: string | null | undefined): string {
  if (!detail) return ''
  return detail.replace(MARKER_RE, '').replace(/\s*·\s*$/, '').trim()
}

// ==================== HELPER ĐO (dùng chung pipeline chính + embedOnly) ====================
// FB-Đợt7-R4 (C5): logic đo embedding_success_rate từng sống inline trong route
// 6000 dòng — không test nào pin được hành vi fix BUG2-064/065. Tách ra thuần
// để regression test chứng minh 4 đường đo (skip/fresh/resume-partial/alias).

export interface EmbeddingSuccessRateArgs {
  /** Bước embeddings CÓ chạy trong lần pipeline này không (đường skip = không đo) */
  embeddingsStepRan: boolean
  /** Tổng số chunk của document (mẫu số) */
  chunkCount: number
  /** Số chunk đã có vector THẬT TRƯỚC run này (đường resume-partial) */
  realVectorsBefore: number
  /** Số vector mới lưu THÀNH CÔNG trong run này */
  vectorsSaved: number
}

/**
 * embedding_success_rate — trả null khi KHÔNG đo được (bước embeddings không
 * chạy / không có chunk → evaluated=false, "thiếu đo ≠ hỏng"), ngược lại
 * min(1, (vector-thật-trước + mới-lưu-thành-công)/tổng-chunk).
 *
 * Pin 4 đường (BUG2-064 + BUG2-065 + FB-Đợt7-R4 F2):
 *   - SKIP (resume đã đủ vector): embeddingsStepRan=false → null (bản cũ đo
 *     0/n → FAIL giả → doc kẹt 'partial' vĩnh viễn).
 *   - FRESH: (0 + n)/n = 1.
 *   - RESUME-PARTIAL (30/33 thật + 3 mới): (30+3)/33 = 1 (bản cũ 3/33 FAIL giả).
 *   - ALIAS needing=0 (embeddingsSavedCount được gán = realVectorCount): tử
 *     số 2n/n → kẹp 1 bởi min.
 */
export function computeEmbeddingSuccessRate(args: EmbeddingSuccessRateArgs): number | null {
  if (args.chunkCount <= 0 || !args.embeddingsStepRan) return null
  return Math.min(1, (args.realVectorsBefore + args.vectorsSaved) / args.chunkCount)
}

/**
 * Số vector thực sự GHI thành công vào Qdrant từ một batch — FB-Đợt7-R4 (F2):
 * generateAndSaveEmbeddings bản cũ trả `vectorPoints.length` (số vector CHUẨN
 * BỊ ghi) kể cả khi updateChunkVectors trả false (Qdrant lỗi) → success-rate
 * PASS giả 1.0 đúng lúc mass-embed-fail. Chỉ đếm khi lệnh ghi thành công.
 */
export function savedVectorCount(updateOk: boolean, preparedCount: number): number {
  return updateOk ? preparedCount : 0
}
