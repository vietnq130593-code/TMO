/**
 * P4-M2 · MODEL COMPARISON — bảng so sánh model trên AgentRunRecord (mục #8b).
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md §P4-M2 (MATH.pdf §ANOVA — so sánh
 * ≥3 model). Tiền đề bắt buộc cho P6 credit assignment: biết run nào chạy
 * bằng model nào (cột AgentRunRecord.model — wiring goal-loop + delegation).
 *
 * Thiết kế:
 *   - buildModelComparison(rows, windowDays) — PHẦN THUẦN (không DB, test
 *     độc lập được): nhóm theo model → bảng per-model (n, status breakdown,
 *     success-rate = completed/terminal + Wilson CI P2-M2) + ANOVA one-way
 *     (anovaF — stats) trên cycles/tokens KHI ≥3 model đủ n≥10 mỗi nhóm.
 *   - fetchModelComparison(windowDays=90) — đọc AgentRunRecord trong cửa sổ
 *     (model != null), cap 5000 row mới nhất.
 *
 * Quy ước:
 *   - terminal = completed + failed + incomplete + cancelled (loại 'running'
 *     đang chạy + status lạ khỏi mẫu số success-rate — thành thật phải là
 *     trạng thái chốt); success-rate null khi terminal = 0 (không định nghĩa
 *     — không fake 0).
 *   - ciUsable = terminal ≥ 5 ∧ CI width ≤ 0.5 (guard consumer P2-M2 —
 *     precedent getSuccessProbabilityWithCI; bảng là báo cáo đọc-được nên
 *     CI vẫn trả kèm n nhỏ, cờ cho người đọc biết độ tin).
 *   - ANOVA từ chối tính (null + note) khi < 3 model đủ n≥10 — "ANOVA từ
 *     chối tính khi thiếu nhóm" (spec §P4-M2 kiểm chứng).
 *
 * Fail-open TOÀN PHẦN (nguyên tắc 3): lỗi DB → zero-state { n: 0, note },
 * KHÔNG throw. Read-only — không ghi gì vào DB.
 */

import { wilsonCI, anovaF } from '@/lib/stats'
import { db } from '@/lib/db'

/** Số model tối thiểu để ANOVA có nghĩa (spec §P4-M2: "khi ≥3 model đủ n≥10"). */
export const ANOVA_MIN_MODELS = 3
/** Số mẫu tối thiểu MỖI model để nhóm đó được tính vào ANOVA (spec §P4-M2). */
export const ANOVA_MIN_N = 10
/** Cửa sổ mặc định (ngày) — cùng bậc threshold-sweep (60) nhưng rộng hơn vì
 * model-switch thưa sự kiện hơn ngưỡng confidence. */
export const DEFAULT_WINDOW_DAYS = 90
/** Cap row đọc về (chống phình bảng trên hộp 4GB — 5000 run ~ nhiều tuần). */
const FETCH_CAP = 5000

/** Một row AgentRunRecord tối thiểu cho so sánh (subset — test seed dễ). */
export interface ModelRunRow {
  model: string | null
  status: string | null
  cycles: number | null
  tokensUsed: number | null
}

/** Một dòng bảng per-model. */
export interface ModelComparisonEntry {
  model: string
  /** Tổng row của model trong cửa sổ */
  n: number
  completed: number
  failed: number
  incomplete: number
  cancelled: number
  /** Row đang chạy / status lạ — KHÔNG vào mẫu số success-rate */
  running: number
  other: number
  /** completed+failed+incomplete+cancelled — mẫu số success-rate */
  terminal: number
  /** completed/terminal — null khi terminal = 0 */
  successRate: number | null
  /** Wilson CI 95% của successRate — null khi terminal = 0 */
  successCI: { low: number; high: number } | null
  /** Guard consumer P2-M2: terminal ≥ 5 ∧ CI width ≤ 0.5 */
  ciUsable: boolean
}

/** Kết quả ANOVA one-way cho 1 metric (cycles | tokens). */
export interface ModelAnovaResult {
  metric: 'cycles' | 'tokens'
  f: number
  dfBetween: number
  dfWithin: number
  p: number
  groups: Array<{ model: string; n: number }>
}

export interface ModelComparisonReport {
  windowDays: number
  /** Tổng AgentRunRecord trong cửa sổ (kể cả model null) */
  nRuns: number
  /** Row có model != null (tham gia bảng) */
  nWithModel: number
  models: ModelComparisonEntry[]
  anova: {
    cycles: ModelAnovaResult | null
    tokens: ModelAnovaResult | null
    note: string
  }
  generatedAt: string
  /** Ghi chú zero-state — undefined khi có dữ liệu lành */
  note?: string
}

/** Làm tròn 4 chữ số thập phân (cùng chuẩn threshold-sweep). */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'incomplete', 'cancelled'])

/**
 * Xây bảng so sánh từ rows (thuần — mọi phép tính xác định được bằng tay).
 * rows có model null/rỗng bị loại khỏi bảng (nhưng caller đếm được qua nRuns).
 */
export function buildModelComparison(rows: ModelRunRow[], windowDays: number): ModelComparisonReport {
  const byModel = new Map<string, ModelRunRow[]>()
  for (const row of rows) {
    const model = row.model?.trim()
    if (!model) continue
    const bucket = byModel.get(model)
    if (bucket) bucket.push(row)
    else byModel.set(model, [row])
  }

  const models: ModelComparisonEntry[] = []
  const cyclesGroups: Array<{ model: string; values: number[] }> = []
  const tokensGroups: Array<{ model: string; values: number[] }> = []

  for (const [model, bucket] of byModel) {
    let completed = 0
    let failed = 0
    let incomplete = 0
    let cancelled = 0
    let running = 0
    let other = 0
    const cycles: number[] = []
    const tokens: number[] = []
    for (const row of bucket) {
      switch (row.status) {
        case 'completed': completed++; break
        case 'failed': failed++; break
        case 'incomplete': incomplete++; break
        case 'cancelled': cancelled++; break
        case 'running': running++; break
        default: other++; break
      }
      // Continuous cho ANOVA: chỉ row TERMINAL có cycles/tokens CHỐT (running
      // đang giữ giá trị tạm — không vào phép so model).
      if (TERMINAL_STATUSES.has(row.status ?? '')) {
        if (typeof row.cycles === 'number' && Number.isFinite(row.cycles)) cycles.push(row.cycles)
        if (typeof row.tokensUsed === 'number' && Number.isFinite(row.tokensUsed)) tokens.push(row.tokensUsed)
      }
    }
    const terminal = completed + failed + incomplete + cancelled
    const successRate = terminal > 0 ? completed / terminal : null
    // Wilson (P2-M2 — wilsonCI guard p ngoài [0,1] → NaN; successRate luôn
    // trong [0,1] nên an toàn; n nhỏ CI rộng — cờ ciUsable nói rõ độ tin).
    const ci =
      successRate !== null && terminal > 0
        ? (() => {
            const { low, high } = wilsonCI(successRate, terminal)
            return Number.isFinite(low) && Number.isFinite(high)
              ? { low: round4(low), high: round4(high) }
              : null
          })()
        : null
    models.push({
      model,
      n: bucket.length,
      completed,
      failed,
      incomplete,
      cancelled,
      running,
      other,
      terminal,
      successRate: successRate === null ? null : round4(successRate),
      successCI: ci,
      ciUsable: ci !== null && terminal >= 5 && ci.high - ci.low <= 0.5,
    })
    cyclesGroups.push({ model, values: cycles })
    tokensGroups.push({ model, values: tokens })
  }

  // Bảng đọc theo n giảm dần (model nhiều dữ liệu trước — dễ xem nhất)
  models.sort((a, b) => b.n - a.n || a.model.localeCompare(b.model))

  const anovaCycles = buildAnova('cycles', cyclesGroups)
  const anovaTokens = buildAnova('tokens', tokensGroups)
  const anovaNote =
    anovaCycles === null && anovaTokens === null
      ? `ANOVA cần ≥${ANOVA_MIN_MODELS} model × n≥${ANOVA_MIN_N} (hiện có ${cyclesGroups.filter(g => g.values.length >= ANOVA_MIN_N).length} nhóm đủ điều kiện) — chờ dữ liệu`
      : `đủ điều kiện: ${[anovaCycles, anovaTokens].filter(Boolean).map(r => r!.metric).join(' + ')} (≥${ANOVA_MIN_MODELS} model × n≥${ANOVA_MIN_N})`

  return {
    windowDays,
    nRuns: rows.length,
    nWithModel: models.reduce((sum, m) => sum + m.n, 0),
    models,
    anova: { cycles: anovaCycles, tokens: anovaTokens, note: anovaNote },
    generatedAt: new Date().toISOString(),
    note:
      models.length === 0
        ? 'chưa có AgentRunRecord nào có model trong cửa sổ (cột model mới có từ P4-M2 — run mới mới ghi)'
        : undefined,
  }
}

/** ANOVA one-way trên các nhóm đủ n — null khi < ANOVA_MIN_MODELS nhóm đủ điều kiện. */
function buildAnova(
  metric: 'cycles' | 'tokens',
  groups: Array<{ model: string; values: number[] }>,
): ModelAnovaResult | null {
  const eligible = groups.filter(g => g.values.length >= ANOVA_MIN_N)
  if (eligible.length < ANOVA_MIN_MODELS) return null
  const { f, dfBetween, dfWithin, p } = anovaF(eligible.map(g => g.values))
  return {
    metric,
    f: round4(f),
    dfBetween: round4(dfBetween),
    dfWithin: round4(dfWithin),
    p: round4(p),
    groups: eligible.map(g => ({ model: g.model, n: g.values.length })),
  }
}

/**
 * Đọc DB cửa sổ windowDays → bảng so sánh (mọi row trong cửa sổ — row model
 * null bị loại BÊN TRONG builder nhưng vẫn đếm vào nRuns cho trong suốt).
 * Fail-open: lỗi DB → zero-state report (n=0 + note), KHÔNG throw (route
 * luôn 200 — precedent scorecard).
 */
export async function fetchModelComparison(windowDays = DEFAULT_WINDOW_DAYS): Promise<ModelComparisonReport> {
  const since = new Date(Date.now() - windowDays * 24 * 3600_000)
  try {
    const rows = await db.agentRunRecord.findMany({
      where: { createdAt: { gte: since } },
      select: { model: true, status: true, cycles: true, tokensUsed: true },
      orderBy: { createdAt: 'desc' },
      take: FETCH_CAP,
    })
    const report = buildModelComparison(rows, windowDays)
    if (rows.length >= FETCH_CAP) {
      report.note = `cap ${FETCH_CAP} row mới nhất đạt — số liệu có thể cắt lở cửa sổ`
    }
    return report
  } catch (err) {
    // Zero-state fail-open — route vẫn 200 kèm note lỗi (đọc không được ≠ lỗi app)
    const zero = buildModelComparison([], windowDays)
    zero.note = `DB lỗi (fail-open): ${err instanceof Error ? err.message : String(err)}`
    return zero
  }
}
