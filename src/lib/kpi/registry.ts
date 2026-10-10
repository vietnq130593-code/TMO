/**
 * P1-M4 · KPI REGISTRY — SINGLE SOURCE định nghĩa lớp chỉ số có tên, có mục
 * tiêu, có trạng thái (DA.pdf §KPIs and Metrics).
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md §P1-M4 (mục #5). Mỗi KPI:
 *   - key       — khóa snapshot (KpiSnapshot.kpi, unique theo date+kpi)
 *   - goal      — 'higher' (càng cao càng tốt) | 'lower' (càng thấp càng tốt)
 *   - target?   — ngưỡng đặt ban đầu (comment nguồn), chỉnh theo dữ liệu —
 *                 trạng thái chỉ là HIỂN THỊ so sánh, KHÔNG ghim hành vi nào
 *   - compute() — fail-open ĐỘC LẬP: 1 KPI lỗi không kéo cả bảng (đúng
 *                 pattern overview route); trả { value, n, meta? }
 *
 * Nguồn dữ liệu v1 (khoanh vùng 8 nhóm đầu theo blueprint, mở rộng dần):
 *   mission_success_rate — AgentRunRecord 24h (completed/tổng — "incomplete"
 *                          gồm running/cancelled/stuck, đối nghĩa 20-b)
 *   verdict_precision/f1 — P1-M1 scorecard 30 ngày (FP = tuyên bố xong giả)
 *   tool_success_rate    — ToolMetric 24h
 *   anomaly_count_24h    — MetricAnomaly (P1-M3)
 *   eval_ndcg/eval_recall— EvalRun completed MỚI NHẤT (baseline P1-M2)
 *   kb_fallback_rate     — tỉ lệ truy vấn rơi xuống Model-Knowledge (confidence
 *                          < CONFIDENCE_THRESHOLD 0.5). v1 đo trên TRUY VẤN
 *                          EVAL (EvalResult.rawConfidence — eval chạy đúng
 *                          đường production searchUserKB); truy vấn chat
 *                          production chưa có log riêng — nợ ghi nhận ở P2+.
 *   delegation_ratio     — AgentRunRecord có parentRunId / tổng 24h (chống
 *                          vượt trần 2 delegation/run — tỉ lệ sub-run cao
 *                          bất thường là tín hiệu)
 *   digest_gate_fallback_rate — P3-M4: DigestGateEvent 7 ngày (fallback/tổng
 *                          — digest LLM rớt evidence-coverage 0.7 hoặc summary
 *                          rớt ROUGE-L recall 0.3 → chuyển đường an toàn)
 */

import { db } from '@/lib/db'
import { CONFIDENCE_THRESHOLD } from '@/lib/kb-routing/kb-access'
import { computeVerdictScorecard } from '@/lib/eval/verdict-scorecard'
import { meanCI } from '@/lib/stats'

export interface KpiComputeResult {
  /** Giá trị KPI ∈ [0, ∞) hoặc tỉ lệ ∈ [0,1] */
  value: number
  /** Cỡ mẫu đo được — 0 = chưa có dữ liệu (kèm meta.note) */
  n: number
  /** Breakdown/ghi chú nguồn (JSON vào KpiSnapshot.meta) */
  meta?: Record<string, unknown>
}

export interface KpiDef {
  key: string
  label: string
  goal: 'higher' | 'lower'
  /** Ngưỡng hiển thị — undefined = KPI informative (không status) */
  target?: number
  compute: () => Promise<KpiComputeResult>
}

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

function sinceHours(h: number): Date {
  return new Date(Date.now() - h * HOUR_MS)
}

function ratio(part: number, total: number): number {
  return total > 0 ? part / total : 0
}

/**
 * P2-M2 — meanCI 95% (x̄ ± 1.96·s/√n) cho một metric per-case của một eval
 * run (nguồn EvalResult — thay cột meta EvalRun không có, quyết định §P2-M2:
 * "ghi CI vào log + KPI meta (P1-M4) thay thế"). Trả undefined khi không đủ
 * (n < 2 không có độ lệch chuẩn / run không có per-case row) — meta sạch,
 * không nhét NaN vô JSON.
 */
async function evalMetricCI(
  runId: string,
  field: 'ndcgAt5' | 'recallAt5',
): Promise<{ low: number; high: number; n: number } | undefined> {
  try {
    const rows = await db.evalResult.findMany({
      where: { runId },
      select: { [field]: true },
    })
    const xs = rows.map((r) => r[field]).filter((v) => typeof v === 'number' && Number.isFinite(v))
    const ci = meanCI(xs)
    if (ci.n < 2 || !Number.isFinite(ci.low) || !Number.isFinite(ci.high)) return undefined
    return {
      low: Math.round(ci.low * 1000) / 1000,
      high: Math.round(ci.high * 1000) / 1000,
      n: ci.n,
    }
  } catch {
    return undefined // fail-open — KPI vẫn hiển thị value/n như cũ
  }
}

/**
 * KPI_REGISTRY — danh sách KPI đang vận hành. THÊM KPI = thêm 1 entry ở đây
 * (compute + KpiSnapshot tự động theo) — KHÔNG sửa nhiều nơi.
 */
export const KPI_REGISTRY: KpiDef[] = [
  {
    key: 'mission_success_rate',
    label: 'Mission success rate (24h)',
    goal: 'higher',
    // Đặt ban đầu 0.8 — hiệu chỉnh theo dữ liệu baseline P1
    target: 0.8,
    compute: async () => {
      const since = sinceHours(24)
      const [total, completed] = await Promise.all([
        db.agentRunRecord.count({ where: { createdAt: { gte: since } } }),
        db.agentRunRecord.count({ where: { createdAt: { gte: since }, status: 'completed' } }),
      ])
      return {
        value: ratio(completed, total),
        n: total,
        meta: { completed, total, denominator: 'mọi status (incomplete gồm running/cancelled/stuck)' },
      }
    },
  },
  {
    key: 'verdict_precision',
    label: 'Verdict precision — trọng tài (30 ngày)',
    goal: 'higher',
    // FP = tuyên bố "complete" giả — chỉ số an toàn quan trọng nhất của evaluator
    target: 0.9,
    compute: async () => {
      const sc = await computeVerdictScorecard(30)
      return {
        value: sc.n > 0 ? sc.precision : 0,
        n: sc.n,
        meta: { tp: sc.tp, fp: sc.fp, fn: sc.fn, tn: sc.tn, note: sc.note },
      }
    },
  },
  {
    key: 'verdict_f1',
    label: 'Verdict F1 — trọng tài (30 ngày)',
    goal: 'higher',
    target: 0.85,
    compute: async () => {
      const sc = await computeVerdictScorecard(30)
      return {
        value: sc.n > 0 ? sc.f1 : 0,
        n: sc.n,
        meta: { precision: sc.precision, recall: sc.recall, note: sc.note },
      }
    },
  },
  {
    key: 'tool_success_rate',
    label: 'Tool success rate (24h)',
    goal: 'higher',
    target: 0.9,
    compute: async () => {
      const since = sinceHours(24)
      const [total, success] = await Promise.all([
        db.toolMetric.count({ where: { timestamp: { gte: since } } }),
        db.toolMetric.count({ where: { timestamp: { gte: since }, success: true } }),
      ])
      return { value: ratio(success, total), n: total, meta: { success, total } }
    },
  },
  {
    key: 'anomaly_count_24h',
    label: 'Anomaly count (24h — P1-M3 IQR)',
    goal: 'lower',
    // Nghiêm khắc có chủ đích: bất kỳ anomaly nào = off (tín hiệu cảnh báo)
    target: 0,
    compute: async () => {
      const n = await db.metricAnomaly.count({ where: { observedAt: { gte: sinceHours(24) } } })
      return { value: n, n, meta: { source: 'MetricAnomaly (IQR scan P1-M3)' } }
    },
  },
  {
    key: 'eval_ndcg',
    label: 'Eval nDCG@5 (run completed mới nhất)',
    goal: 'higher',
    target: 0.7,
    compute: async () => {
      const run = await db.evalRun.findFirst({
        where: { status: 'completed' },
        orderBy: { startedAt: 'desc' },
        select: { avgNdcg: true, caseCount: true, id: true },
      })
      if (!run) {
        return { value: 0, n: 0, meta: { note: 'chưa có eval run completed — baseline P1-M2' } }
      }
      // P2-M2 — meanCI 95% từ per-case EvalResult (thay cột meta EvalRun không có)
      const ci = await evalMetricCI(run.id, 'ndcgAt5')
      return { value: run.avgNdcg, n: run.caseCount, meta: { runId: run.id, ...(ci ? { ci } : {}) } }
    },
  },
  {
    key: 'eval_recall',
    label: 'Eval recall@5 (run completed mới nhất)',
    goal: 'higher',
    target: 0.8,
    compute: async () => {
      const run = await db.evalRun.findFirst({
        where: { status: 'completed' },
        orderBy: { startedAt: 'desc' },
        select: { avgRecallAt5: true, caseCount: true, id: true },
      })
      if (!run) {
        return { value: 0, n: 0, meta: { note: 'chưa có eval run completed — baseline P1-M2' } }
      }
      // P2-M2 — meanCI 95% từ per-case EvalResult (thay cột meta EvalRun không có)
      const ci = await evalMetricCI(run.id, 'recallAt5')
      return { value: run.avgRecallAt5, n: run.caseCount, meta: { runId: run.id, ...(ci ? { ci } : {}) } }
    },
  },
  {
    key: 'kb_fallback_rate',
    label: 'KB fallback rate (Model-Knowledge, eval queries)',
    goal: 'lower',
    target: 0.2,
    compute: async () => {
      const rows = await db.evalResult.findMany({
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: { rawConfidence: true },
      })
      const usable = rows.filter((r) => typeof r.rawConfidence === 'number' && Number.isFinite(r.rawConfidence))
      const fallback = usable.filter((r) => r.rawConfidence < CONFIDENCE_THRESHOLD).length
      return {
        value: ratio(fallback, usable.length),
        n: usable.length,
        meta: {
          fallback,
          total: usable.length,
          threshold: CONFIDENCE_THRESHOLD,
          source: 'EvalResult.rawConfidence (eval chạy đường production searchUserKB)',
          note: 'truy vấn chat production chưa có log riêng — nợ P2+',
        },
      }
    },
  },
  {
    key: 'delegation_ratio',
    label: 'Delegation ratio (24h)',
    goal: 'lower',
    target: 0.5,
    compute: async () => {
      const since = sinceHours(24)
      const [total, delegated] = await Promise.all([
        db.agentRunRecord.count({ where: { createdAt: { gte: since } } }),
        db.agentRunRecord.count({ where: { createdAt: { gte: since }, parentRunId: { not: null } } }),
      ])
      return {
        value: ratio(delegated, total),
        n: total,
        meta: { delegated, total, guard: 'chống vượt trần 2 delegation/run' },
      }
    },
  },
  {
    key: 'digest_gate_fallback_rate',
    label: 'Digest gate fallback rate (7 ngày — P3-M4)',
    goal: 'lower',
    // Fallback là đường AN TOÀN (evidence-preserving) nên hệ thống không hỏng
    // khi tỉ lệ cao — nhưng fallback cao = digest/summary LLM hay mất dẫn
    // chứng, đáng khảo sát prompt/model utility. 0.3 đặt ban đầu, chỉnh theo
    // dữ liệu (cùng quy ước mọi target KPI).
    target: 0.3,
    compute: async () => {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
      const [total, fallback, compression, summarization] = await Promise.all([
        db.digestGateEvent.count({ where: { createdAt: { gte: since } } }),
        db.digestGateEvent.count({ where: { createdAt: { gte: since }, outcome: 'fallback' } }),
        db.digestGateEvent.count({ where: { createdAt: { gte: since }, kind: 'compression' } }),
        db.digestGateEvent.count({ where: { createdAt: { gte: since }, kind: 'summarization' } }),
      ])
      return {
        value: ratio(fallback, total),
        n: total,
        meta: {
          fallback,
          total,
          compression,
          summarization,
          source: 'DigestGateEvent (P3-M4 — gate coverage 0.7 / ROUGE-L 0.3)',
        },
      }
    },
  },
]

export type KpiStatus = 'on_target' | 'near' | 'off' | 'no_target' | 'no_data'

/**
 * Trạng thái hiển thị so target theo dải ±10% (blueprint §P1-M4):
 *   goal higher: value ≥ target → on_target; ≥ target·0.9 → near; else off
 *   goal lower : value ≤ target → on_target; ≤ target·1.1 → near; else off
 * target 0 tự suy ra đúng (dải near suy biến — mọi giá trị > 0 là off với
 * goal lower — đúng ngữ nghĩa cảnh báo anomaly_count).
 * Không có target → 'no_target' (KPI informative).
 * LƯU Ý: hàm này KHÔNG biết cỡ mẫu — trạng thái n=0 (chưa đo được gì) do
 * computeOne gán 'no_data' TRƯỚC khi gọi hàm này (tránh đọc nhầm on_target
 * khi value=0 chỉ vì chưa có dữ liệu — FB-P1-R1-02).
 */
export function statusForKpi(def: KpiDef, value: number): KpiStatus {
  if (typeof def.target !== 'number' || !Number.isFinite(def.target)) return 'no_target'
  const t = def.target
  if (def.goal === 'higher') {
    if (value >= t) return 'on_target'
    if (value >= t * 0.9) return 'near'
    return 'off'
  }
  if (value <= t) return 'on_target'
  if (value <= t * 1.1) return 'near'
  return 'off'
}

// Giữ DAY_MS dùng chung (export cho compute.ts nếu cần)
export { DAY_MS }
