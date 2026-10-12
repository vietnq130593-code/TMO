/**
 * BRAIN-P4 · COMPOSITE REWARD — "thưởng tổng hợp" LOG-ONLY (blueprint §3.1 + §4.4)
 * ============================================================================
 *
 * Q1 USER ĐÃ CHỐT (2026-10-12, blueprint v0.9 §8 dòng 2): composite reward
 * chuẩn hóa từng thành phần, LOG-ONLY 2 đợt quan sát TRƯỚC khi tham gia quyết
 * định. Đợt quan sát 1 bắt đầu từ v0.9:
 *   - reward được TÍNH + GHI SONG SONG (console log mỗi run close + report
 *     GET /api/brain/policy) — KHÔNG tham gia updateQ (W1/W2 giữ nguyên
 *     nhị phân ±1 đúng §P6-M2), KHÔNG tác động bất kỳ quyết định nào.
 *
 * CÔNG THỨC (blueprint §3.1 — mỗi thành phần PHẢI chuẩn hóa trước khi nhân
 * trọng số; audit C1: tokens ~10³–10⁵ trong khi faithfulness 0–1 — nhân
 * thẳng thì w vô nghĩa):
 *
 *   R = w₁·Outcome* + w₂·Efficiency* + w₃·Quality*
 *     Outcome*     ∈ {0,1}   — verdict (refuted → 0) / run-complete
 *     Efficiency*  ∈ [−1,1]  — (baseline − thực tế)/baseline, baseline =
 *                              TRUNG VỊ tokensUsed theo model (hạ tầng
 *                              Wilson/ANOVA P4-M2 đã có)
 *     Quality*     ∈ [0,1]   — faithfulness
 *
 * Thành phần THIẾU (null) → RENORMALIZE trọng số còn lại (tổng w của các
 * thành phần có mặt) — R luôn nằm trong khoảng [−1,1] hợp lệ, không bị "trừ
 * hờm" khi một nguồn chưa có. GHI NHẬN THẲNG (blueprint v0.9): agent-run
 * phase này KHÔNG có nguồn faithfulness (EvalResult faithfulnessMedian thuộc
 * eval KB, không nối được vào agent run) → Quality* = null trên mọi mẫu
 * agent-run — renormalize w₁+w₂; công thức hỗ trợ đầy đủ khi nguồn xuất hiện.
 *
 * TRỌNG SỐ (doctrine #1 — hardcode từ dữ liệu kèm chú thích nguồn):
 *   REWARD_WEIGHTS = {outcome: 1/3, efficiency: 1/3, quality: 1/3}
 *   Nguồn: khởi điểm bằng nhau — sweep dữ liệu (`sweepRewardWeights`) chưa
 *   khả thi trên DB đo ngày triển khai (0 AgentRunRecord — không có 2 model
 *   nào đủ mẫu đối chứng). `sweepRewardWeights()` đã sống (grid simplex +
 *   Spearman time-split — xem JSDoc) và được gọi mỗi lần dựng report
 *   GET /api/brain/policy; khi đủ dữ liệu, kết quả sweep sẽ là cơ sở đổi
 *   REWARD_WEIGHTS ở commit kế tiếp (kèm chú thích nguồn mới — doctrine #1).
 *
 * LEDGER (blueprint §4.4 — "không bảng trừ RewardWeight sweep nếu cần"):
 *   đọc (READ-ONLY) từ `AgentRunRecord` (kết cục + tokens + model/agent) +
 *   `ArbiterVerdict` (outcome confirmed/refuted theo session) +
 *   `StrategyAdaptationLog` (nguồn W1 — phase này chưa cần cho reward mẫu).
 *   KHÔNG ghi bảng nào — mọi hàm ghi DB đều không tồn tại trong module này.
 */

import { db } from '@/lib/db'
import { quantile } from '@/lib/stats'

// ==================== CONFIG ====================

/** Trọng số composite reward (doctrine #1 — xem header cho nguồn đầy đủ). */
export interface RewardWeights {
  outcome: number
  efficiency: number
  quality: number
}

/**
 * Khởi điểm 1/3 mỗi thành phần — SWEEP CHƯA KHẢ THI trên DB triển khai
 * (2026-10-12: 0 AgentRunRecord, không model nào đủ mẫu). Đổi giá trị này
 * CHỈ kèm sweepRewardWeights() đã chạy + chú thích nguồn (doctrine #1).
 */
export const REWARD_WEIGHTS: RewardWeights = {
  outcome: 1 / 3,
  efficiency: 1 / 3,
  quality: 1 / 3,
}

// ==================== THUẦN — CHUẨN HÓA + HỢP THÀNH (test trực tiếp) ====================

/** Các thành phần đã chuẩn hóa của composite reward (null = thiếu nguồn). */
export interface RewardComponents {
  /** Outcome* ∈ {0,1} — luôn có khi run chốt (verdict/run-complete). */
  outcome: number
  /** Efficiency* ∈ [−1,1] — null khi baseline không tính được (≤0/NaN). */
  efficiency: number | null
  /** Quality* ∈ [0,1] — null khi không có nguồn faithfulness. */
  quality: number | null
}

/**
 * Efficiency* = (baseline − actual)/baseline kẹp [−1,1] — thuần.
 * baseline ≤ 0 / NaN / actual NaN → null (không bịa số — caller renormalize).
 * baseline = trung vị tokens theo model (đúng spec §3.1 — hàm median ở tầng
 * ledger collectTokenBaselines).
 */
export function normalizeEfficiency(actual: number, baseline: number): number | null {
  if (!Number.isFinite(actual) || actual < 0 || !Number.isFinite(baseline) || baseline <= 0) {
    return null
  }
  return Math.min(1, Math.max(-1, (baseline - actual) / baseline))
}

/** Kết quả composite reward đầy đủ để log/report (truy vết từng thành phần). */
export interface CompositeRewardResult {
  /** R ∈ [−1,1] — tổng w·thành-phần sau renormalize. */
  reward: number
  /** Trọng số THỰC SỰ dùng (sau renormalize — tổng = 1). */
  weightsUsed: RewardWeights
  /** Bản sao thành phần đã chuẩn hóa (đầy đủ cho audit/log). */
  components: RewardComponents
}

/**
 * Hợp thành R từ các thành phần ĐÃ chuẩn hóa — thuần.
 * Renormalize: thành phần null bị loại khỏi tử số và mẫu số (tổng w của các
 * thành phần có mặt). Toàn bộ null / tổng w ≤ 0 / w âm / outcome ngoài
 * {0,1} → null (không có gì để nói — caller bỏ mẫu, không bịa R=0).
 * Hợp đồng ném lỗi: KHÔNG throw — mọi đầu vào suy biến trả null (module
 * reward là lớp đo lường log-only, không có "lỗi lập trình caller" nào cần
 * ném ở hàm thuần này; các guard chiều dài nằm ở tầng caller có ngữ cảnh).
 */
export function compositeReward(
  components: RewardComponents,
  weights: RewardWeights = REWARD_WEIGHTS,
): CompositeRewardResult | null {
  const wOk =
    [weights.outcome, weights.efficiency, weights.quality].every(
      w => typeof w === 'number' && Number.isFinite(w) && w >= 0,
    ) && weights.outcome + weights.efficiency + weights.quality > 0
  if (!wOk) return null
  if (components.outcome !== 0 && components.outcome !== 1) return null
  if (
    components.efficiency !== null
    && !(Number.isFinite(components.efficiency) && components.efficiency >= -1 && components.efficiency <= 1)
  ) return null
  if (
    components.quality !== null
    && !(Number.isFinite(components.quality) && components.quality >= 0 && components.quality <= 1)
  ) return null

  const pairs: Array<[number, number]> = [[components.outcome, weights.outcome]]
  if (components.efficiency !== null) pairs.push([components.efficiency, weights.efficiency])
  if (components.quality !== null) pairs.push([components.quality, weights.quality])

  const totalW = pairs.reduce((s, [, w]) => s + w, 0)
  if (!(totalW > 0)) return null
  const reward = pairs.reduce((s, [v, w]) => s + v * w, 0) / totalW
  if (!Number.isFinite(reward)) return null

  const scale = 1 / totalW
  return {
    reward,
    weightsUsed: {
      outcome: weights.outcome * scale,
      efficiency: components.efficiency !== null ? weights.efficiency * scale : 0,
      quality: components.quality !== null ? weights.quality * scale : 0,
    },
    components,
  }
}

// ==================== LEDGER — ĐỌC (READ-ONLY tuyệt đối) ====================

/** 1 row AgentRunRecord usable cho reward/policy (trạng thái CHỐT). */
export interface RunLedgerRow {
  id: string
  runId: string
  sessionId: string
  model: string
  agentName: string | null
  delegated: boolean
  /** 1 = complete, 0 = không — trạng thái chốt (complete boolean). */
  complete: number
  tokensUsed: number
  createdAt: Date
}

/** Tally verdict đã resolve của 1 session (nguồn Outcome* — đúng quy ước W2). */
export interface VerdictTally {
  confirmed: number
  refuted: number
}

/**
 * Outcome* từ bằng chứng verdict + kết cục run — thuần (blueprint §3.1
 * "verdict/run-complete"; quy ước ưu tiên kế thừa W2 §P6-M2: refuted thắng
 * mọi chiều — verdict nói công việc bị bác thì không cộng):
 *   session có refuted > 0                                → 0
 *   session có confirmed > 0 VÀ run complete              → 1
 *   còn lại (không verdict / confirmed nhưng run hỏng)    → complete ? 1 : 0
 */
export function outcomeFromEvidence(complete: boolean, tally: VerdictTally | null): 0 | 1 {
  if (tally && tally.refuted > 0) return 0
  if (tally && tally.confirmed > 0 && complete) return 1
  return complete ? 1 : 0
}

/**
 * Median tokens theo model từ các row usable — READ-ONLY.
 * Map model → median (quantile 0.5, cùng helper stats như replay §4.3).
 * Model không có row usable nào → không có key trong map (caller → null).
 */
export async function collectTokenBaselines(rows: readonly RunLedgerRow[]): Promise<Map<string, number>> {
  const byModel = new Map<string, number[]>()
  for (const r of rows) {
    const arr = byModel.get(r.model) ?? []
    arr.push(r.tokensUsed)
    byModel.set(r.model, arr)
  }
  const out = new Map<string, number>()
  for (const [model, tokens] of byModel) {
    const med = quantile(tokens, 0.5)
    if (Number.isFinite(med) && med > 0) out.set(model, med)
  }
  return out
}

/**
 * Đọc ledger reward READ-ONLY: AgentRunRecord usable (trạng thái chốt) +
 * tally ArbiterVerdict theo session + baseline median tokens theo model.
 * Sắp xếp createdAt asc, id asc (tie-break — bài học flaky FB-BRAIN-P2-R2-02).
 * Lỗi DB → throw (caller fail-open; các caller production đều .catch).
 */
export async function collectRewardLedger(cap = 5000): Promise<{
  rows: RunLedgerRow[]
  verdicts: Map<string, VerdictTally>
  baselines: Map<string, number>
}> {
  const raw = await db.agentRunRecord.findMany({
    select: {
      id: true, runId: true, sessionId: true, model: true, agentName: true,
      parentRunId: true, complete: true, tokensUsed: true, createdAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.min(10000, Math.floor(cap))),
  })
  const rows: RunLedgerRow[] = raw
    .filter(
      r => typeof r.model === 'string' && r.model !== ''
        && typeof r.complete === 'boolean'
        && typeof r.tokensUsed === 'number' && Number.isFinite(r.tokensUsed) && r.tokensUsed >= 0,
    )
    .map(r => ({
      id: r.id,
      runId: typeof r.runId === 'string' && r.runId !== '' ? r.runId : r.id,
      sessionId: r.sessionId,
      model: r.model as string,
      agentName: r.agentName,
      delegated: r.parentRunId !== null,
      complete: r.complete === true ? 1 : 0,
      tokensUsed: r.tokensUsed as number,
      createdAt: r.createdAt,
    }))

  const verdictRows = await db.arbiterVerdict.findMany({
    where: { outcome: { not: null } },
    select: { sessionId: true, outcome: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 10000,
  })
  const verdicts = new Map<string, VerdictTally>()
  for (const v of verdictRows) {
    const t = verdicts.get(v.sessionId) ?? { confirmed: 0, refuted: 0 }
    if (v.outcome === 'confirmed') t.confirmed += 1
    else if (v.outcome === 'refuted') t.refuted += 1
    verdicts.set(v.sessionId, t)
  }

  const baselines = await collectTokenBaselines(rows)
  return { rows, verdicts, baselines }
}

/**
 * Tính composite reward cho 1 row ledger — thuần (kết hợp các hàm thuần
 * trên). Trả null khi không hợp được (xem compositeReward) — caller bỏ.
 */
export function computeRunReward(
  row: Pick<RunLedgerRow, 'complete' | 'tokensUsed' | 'model'>,
  tally: VerdictTally | null,
  baselines: ReadonlyMap<string, number>,
  weights: RewardWeights = REWARD_WEIGHTS,
): CompositeRewardResult | null {
  const outcome = outcomeFromEvidence(row.complete === 1, tally)
  const baseline = baselines.get(row.model)
  const efficiency = baseline === undefined ? null : normalizeEfficiency(row.tokensUsed, baseline)
  // Quality* = faithfulness ∈ [0,1] — agent-run phase này KHÔNG có nguồn
  // (EvalResult faithfulnessMedian thuộc eval KB, không nối vào agent run)
  // → null → compositeReward renormalize w₁+w₂ (xem header).
  const quality: number | null = null
  return compositeReward({ outcome, efficiency, quality }, weights)
}

// ==================== LOG-ONLY (đợt quan sát — Q1 chốt 2026-10-12) ====================

/**
 * GHI SONG SONG composite reward của 1 run vừa chốt — LOG-ONLY TUYỆT ĐỐI:
 * chỉ console.log (đợt quan sát 1, blueprint v0.9 §8 dòng 2) + trả breakdown
 * cho caller. KHÔNG ghi bảng nào, KHÔNG đụng updateQ (W2 giữ nhị phân ±1),
 * KHÔNG đổi quyết định nào. Đọc baseline median qua ledger (READ-ONLY).
 * Fail-open: mọi lỗi → log cảnh báo, trả null.
 */
export async function logCompositeRewardForRun(input: {
  model: string
  agentName?: string | null
  complete: boolean
  tokensUsed: number
  confirmed: number
  refuted: number
}): Promise<CompositeRewardResult | null> {
  try {
    const tally: VerdictTally = { confirmed: input.confirmed, refuted: input.refuted }
    const { baselines } = await collectRewardLedger()
    const result = computeRunReward(
      { complete: input.complete ? 1 : 0, tokensUsed: input.tokensUsed, model: input.model },
      tally,
      baselines,
    )
    if (!result) {
      console.log(
        `[Brain-C] composite reward (log-only): model=${input.model} KHÔNG hợp được (thiếu baseline/hợp lệ) — bỏ ghi đợt quan sát`,
      )
      return null
    }
    const eff = result.components.efficiency
    console.log(
      `[Brain-C] composite reward LOG-ONLY (đợt quan sát — chưa tham gia quyết định): model=${input.model} agent=${input.agentName ?? '—'} R=${result.reward.toFixed(4)} (outcome*=${result.components.outcome} · efficiency*=${eff === null ? 'null' : eff.toFixed(4)} · quality*=null-renormalize · w=${result.weightsUsed.outcome.toFixed(2)}/${result.weightsUsed.efficiency.toFixed(2)}/${result.weightsUsed.quality.toFixed(2)}) — updateQ giữ nguyên W2 nhị phân ±1`,
    )
    return result
  } catch (err) {
    console.warn(
      '[Brain-C] logCompositeRewardForRun failed (fail-open — log-only không được làm hỏng run):',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

// ==================== SWEEP TRỌNG SỐ (doctrine #1 — công cụ dẫn xuất) ====================

/** 1 mẫu sweep: reward theo từng trọng số ứng viên sẽ tính từ đây. */
export interface SweepSample {
  model: string
  outcome: number
  efficiency: number | null
  quality: number | null
}

/** Kết quả sweep — weights luôn hợp lệ (feasible=false → trả về khởi điểm). */
export interface SweepOutcome {
  feasible: boolean
  weights: RewardWeights
  /** Lý do không khả thi (rỗng khi feasible) — hiển thị trong report. */
  reason: string
  /** Số model đủ mẫu đối chứng 2 nửa thời-gian. */
  nModels: number
  /** Spearman ρ của cấu hình thắng (NaN khi không khả thi). */
  correlation: number
}

/**
 * Spearman rank correlation với average-rank cho tie — thuần, không phụ
 * thuộc thư viện ngoài (n < 2 hoặc pair thiếu → NaN).
 */
export function spearmanRank(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 2) return Number.NaN
  const ranks = (xs: readonly number[]): number[] => {
    const idx = xs.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v)
    const out = new Array<number>(xs.length).fill(0)
    let k = 0
    while (k < idx.length) {
      let j = k
      while (j + 1 < idx.length && idx[j + 1].v === idx[k].v) j += 1
      const avg = (k + j) / 2 + 1 // average rank 1-based
      for (let t = k; t <= j; t++) out[idx[t].i] = avg
      k = j + 1
    }
    return out
  }
  const ra = ranks(a)
  const rb = ranks(b)
  const ma = ra.reduce((s, v) => s + v, 0) / ra.length
  const mb = rb.reduce((s, v) => s + v, 0) / rb.length
  let num = 0
  let da = 0
  let dbb = 0
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb)
    da += (ra[i] - ma) * (ra[i] - ma)
    dbb += (rb[i] - mb) * (rb[i] - mb)
  }
  if (da === 0 || dbb === 0) return Number.NaN
  return num / Math.sqrt(da * dbb)
}

/**
 * Sweep trọng số composite reward (doctrine #1 — "hardcode từ dữ liệu"):
 * grid simplex {0, 0.25, 0.5, 0.75, 1}³ chuẩn hóa tổng 1; mỗi cấu hình tính
 * mean-R theo model trên NỬA ĐẦU thời gian, rồi đo Spearman với success-rate
 * theo model trên NỬA SAU — cấu hình nào khiến R quá khứ "đoán tốt" kết cục
 * tương lai sẽ thắng (proxy alignment — reward là chất lượng đại diện cho
 * thành công, không phải bản sao của nó). Ties → cấu hình ĐẦU TIÊN trong thứ
 * tự duyệt tất định (feasible và deterministic cùng một dữ liệu).
 *
 * KHÔNG KHẢ THI (< 2 model có ≥ 3 mẫu ở CẢ 2 nửa — không đối chứng chéo)
 * → trả REWARD_WEIGHTS khởi điểm + reason — KHÔNG bịa correlation.
 */
export function sweepRewardWeights(samples: readonly SweepSample[]): SweepOutcome {
  const infeasible = (reason: string): SweepOutcome => ({
    feasible: false,
    weights: { ...REWARD_WEIGHTS },
    reason,
    nModels: 0,
    correlation: Number.NaN,
  })
  if (samples.length < 6) {
    return infeasible(`chưa đủ mẫu (${samples.length} < 6) — cần ≥ 2 model × ≥ 3 mẫu mỗi nửa thời gian`)
  }

  // Chia 2 nửa theo THỜI GIAN (thứ tự truyền vào = createdAt asc — caller
  // collectRewardLedger đã sắp; sweep thuần tin hợp đồng caller, ghi JSDoc).
  const half = Math.floor(samples.length / 2)
  const past = samples.slice(0, half)
  const future = samples.slice(half)

  // FB-BRAIN-P4-R1-10: bản trước tính kèm field `r` (mean composite default
  // weights) cho cả 2 nửa nhưng KHÔNG consumer nào đọc (grid loop tự tính lại
  // theo từng cấu hình w) — dead computation, bỏ. Chỉ giữ outcome + n.
  const perModel = (arr: readonly SweepSample[]): Map<string, { outcome: number; n: number }> => {
    const m = new Map<string, number[]>()
    for (const s of arr) {
      const outs = m.get(s.model) ?? []
      outs.push(s.outcome)
      m.set(s.model, outs)
    }
    const out = new Map<string, { outcome: number; n: number }>()
    for (const [model, outs] of m) {
      out.set(model, {
        outcome: outs.reduce((s, v) => s + v, 0) / outs.length,
        n: outs.length,
      })
    }
    return out
  }

  const pastByModel = perModel(past)
  const futureByModel = perModel(future)
  const common = [...pastByModel.keys()].filter(
    m => (pastByModel.get(m)?.n ?? 0) >= 3 && (futureByModel.get(m)?.n ?? 0) >= 3,
  )
  if (common.length < 2) {
    return infeasible(
      `chưa đủ model đối chứng (${common.length} < 2 model có ≥ 3 mẫu ở cả 2 nửa thời gian) — giữ trọng số khởi điểm`,
    )
  }

  const GRID = [0, 0.25, 0.5, 0.75, 1] as const
  let best: { weights: RewardWeights; rho: number } | null = null
  for (const wo of GRID) {
    for (const we of GRID) {
      for (const wq of GRID) {
        const total = wo + we + wq
        if (total <= 0) continue
        const w: RewardWeights = { outcome: wo / total, efficiency: we / total, quality: wq / total }
        // Mean-R theo model ở NỬA ĐẦU với cấu hình w này
        const pastR = common.map(m => {
          const s = past.filter(x => x.model === m)
          const rs = s
            .map(x => compositeReward({ outcome: x.outcome, efficiency: x.efficiency, quality: x.quality }, w))
            .filter((r): r is CompositeRewardResult => r !== null)
          return rs.length > 0 ? rs.reduce((sum, r) => sum + r.reward, 0) / rs.length : 0
        })
        const futureOutcome = common.map(m => futureByModel.get(m)?.outcome ?? 0)
        const rho = spearmanRank(pastR, futureOutcome)
        if (!Number.isFinite(rho)) continue
        if (best === null || rho > best.rho) best = { weights: w, rho }
      }
    }
  }
  if (!best) {
    return infeasible('mọi cấu hình grid đều ra Spearman NaN (dữ liệu degenerate — rank hằng) — giữ trọng số khởi điểm')
  }
  return {
    feasible: true,
    weights: best.weights,
    reason: `thắng grid simplex với Spearman ρ=${best.rho.toFixed(4)} trên ${common.length} model đối chứng`,
    nModels: common.length,
    correlation: best.rho,
  }
}
