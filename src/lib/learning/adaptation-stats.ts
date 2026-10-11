/**
 * P4-M1 · ADAPTATION STATS — cổng kiểm định thống kê cho Layer 9 adaptation
 * (mục #8 — MATH.pdf §Hypothesis Testing, DA.pdf §Hypothesis Testing).
 *
 * Nguồn: BLUEPRINT-STATS-LEARNING-P0-P6.md §P4-M1. Thay quy tắc đếm ≥2/≥3
 * của Layer 9 bằng kiểm định ý nghĩa thống kê: với mỗi cặp chiến lược
 * (fromStrategy → toStrategy) có tiền sử trong StrategyAdaptationLog:
 *   - nhóm A (before) = outcome các session đã chạy fromStrategy
 *   - nhóm B (after)  = outcome các session đã chạy toStrategy
 * Bài toán nhị phân (successful) → χ² 2×2 (Yates) khi mọi expected cell ≥5,
 * ngược lại Fisher exact (cả hai đã có trong stats/inference.ts từ P0-1 —
 * chiSquare2x2 TỰ chuyển Fisher khi expected < 5, đúng quy tắc Cochran).
 *
 * Gate: áp dụng chiến lược mới khi p < 0.05 (one-sided theo hướng CẢI THIỆN)
 * HOẶC n < minSample mỗi nhóm (quy tắc cũ giữ nguyên hành vi khi thiếu dữ
 * liệu — KHÔNG đổi khởi động lạnh).
 *
 * Chế độ vận hành (env ADAPTATION_STATS_GATE, default OFF — log-only):
 *   - OFF (mặc định): gate chạy + log + lưu statsJson NHƯNG KHÔNG chặn —
 *     "chạy 2 đợt quan sát" trước khi chặn thật (điểm dừng quyết định user
 *     #3 blueprint — KHÔNG tự ý bật).
 *   - ON: pass=false → applyAdaptationToSession KHÔNG merge directives
 *     (log adaptation-blocked-by-stats).
 *
 * Fail-open tuyệt đối (nguyên tắc 3): DB lỗi / dữ liệu thiếu → không có
 * gate → hành vi cũ nguyên vẹn. Learning side-channel KHÔNG BAO GIỜ làm
 * chết workflow.
 */

import { chiSquare2x2, welchTTest } from '@/lib/stats'
import { db } from '@/lib/db'
import { getTuningEnum } from '@/lib/learning/tuning-store'

/**
 * Số mẫu tối thiểu MỖI nhóm để phép thử có hiệu lực (spec §P4-M1: "n<10 mỗi
 * nhóm → insufficient — giữ hành vi cũ").
 */
export const ADAPTATION_STATS_MIN_SAMPLE = 10

/** Ngưỡng ý nghĩa one-sided (spec §P4-M1: "p < 0.05"). */
export const ADAPTATION_STATS_ALPHA = 0.05

/** Kết luận của cổng — đúng shape spec §P4-M1 (statsJson: {test,p,nA,nB,decision}). */
export interface AdaptationStatsDecision {
  /** true = cho áp chiến lược mới; false = chặn (khi gate ON) */
  pass: boolean
  test: 'chi2' | 'fisher' | 'welch_t' | 'insufficient'
  /** p one-sided theo hướng cải thiện — null khi insufficient/degenerate */
  p: number | null
  nA: number
  nB: number
  reason: string
}

/** Welch-t bổ trợ trên biến liên tục (cycles/tokens cùng session — spec
 * §P4-M1 "nếu có biến liên tục → Welch-t bổ trợ"). TWO-SIDED p — hướng giải
 * thích do người quan sát (cycles thấp hơn = tốt); CHỈ dùng làm giàu log,
 * KHÔNG tham gia quyết định pass/block. */
export interface ContinuousSupport {
  test: 'welch_t'
  t: number
  p: number
  nA: number
  nB: number
}

/**
 * CỔNG THUẦN — đánh giá bằng chứng before/after (mảng boolean theo thứ tự
 * thời gian của session). Toàn bộ phép tính xác định được bằng tay — không
 * DB, không side-effect.
 *
 * Bảng 2×2: hàng = nhóm (before/after), cột = (success/fail):
 *   a = successBefore, b = failBefore, c = successAfter, d = failAfter.
 * One-sided theo hướng cải thiện:
 *   - after KHÔNG tốt hơn (pAfter ≤ pBefore) → p = 1 (không có bằng chứng
 *     cải thiện — dù sai biệt lớn theo hướng xấu đi, kiểm định hướng cải
 *     thiện không bác bỏ H0) → block.
 *   - after tốt hơn → fisher branch: fisherExact2x2 đã one-sided theo odd
 *     ratio quan sát (bc > ad ⟺ after tốt hơn → đuôi trái P(X ≤ a)) — dùng
 *     trực tiếp; χ² branch (df=1): one-sided = two-sided/2 (z² = χ²).
 */
export function evaluateAdaptationEvidence(before: boolean[], after: boolean[]): AdaptationStatsDecision {
  const nA = before.length
  const nB = after.length

  // Khởi động lạnh / dữ liệu chưa đủ: GIỮ HÀNH VI CŨ (spec — không đổi cold start)
  if (nA < ADAPTATION_STATS_MIN_SAMPLE || nB < ADAPTATION_STATS_MIN_SAMPLE) {
    return {
      pass: true,
      test: 'insufficient',
      p: null,
      nA,
      nB,
      reason: `n chưa đủ (nA=${nA}, nB=${nB} < ${ADAPTATION_STATS_MIN_SAMPLE} mỗi nhóm) — giữ hành vi cũ theo spec`,
    }
  }

  const a = before.filter(Boolean).length
  const b = nA - a
  const c = after.filter(Boolean).length
  const d = nB - c
  const pBefore = a / nA
  const pAfter = c / nB

  // Phép thử chính — chiSquare2x2 (P0-1) LUÔN Yates + TỰ fallback Fisher
  // khi minExpected < 5 (quy tắc Cochran): MỘT call duy nhất, logic chọn
  // nhánh không nhân đôi. `usedFisher` (mirror cùng ngưỡng 5) chỉ để ĐẶT TÊN
  // test + quyết định cách chuyển one-sided (fisher đã one-sided theo OR
  // quan sát; χ² df=1 phải chia 2) — nếu hai ngưỡng lỡ lệch nhau someday thì
  // p vẫn đúng giá trị lib, chỉ tên nhãn sai (mismatch sẽ bị test bắt).
  const N = nA + nB
  const row1 = a + b
  const row2 = c + d
  const col1 = a + c
  const col2 = b + d
  const denom = row1 * row2 * col1 * col2
  const minExpected =
    denom === 0
      ? 0
      : Math.min((row1 * col1) / N, (row1 * col2) / N, (row2 * col1) / N, (row2 * col2) / N)
  const usedFisher = denom === 0 || minExpected < 5

  const { p: pRaw } = chiSquare2x2(a, b, c, d)

  // Defensive: p không hữu hạn (nếu lib sau này đổi contract — đầu vào boolean
  // hiện tại KHÔNG thể sinh NaN: mọi bảng không-âm cho p hữu hạn, kể cả suy
  // biến biên-0 như "cả 2 nhóm 100% success" → fisher trả đúng 1 → p=1 block,
  // đã pin ở test A7). Fail-open: không kiểm định được → GIỮ HÀNH VI CŨ.
  if (!Number.isFinite(pRaw)) {
    return {
      pass: true,
      test: usedFisher ? 'fisher' : 'chi2',
      p: null,
      nA,
      nB,
      reason: `p không hữu hạn từ phép thử (${usedFisher ? 'fisher' : 'chi2'}: a=${a} b=${b} c=${c} d=${d}) — fail-open giữ hành vi cũ`,
    }
  }

  // One-sided theo hướng CẢI THIỆN
  let pOne: number
  if (pAfter <= pBefore) {
    pOne = 1 // không có cải thiện → kiểm định hướng cải thiện không bác bỏ H0
  } else if (usedFisher) {
    pOne = pRaw // fisher đã one-sided theo odd ratio quan sát = hướng cải thiện
  } else {
    pOne = pRaw / 2 // χ² df=1: two-sided = 2·(1−Φ(|z|)) → one-sided = p/2
  }

  const pass = pOne < ADAPTATION_STATS_ALPHA
  return {
    pass,
    test: usedFisher ? 'fisher' : 'chi2',
    p: Math.round(pOne * 1e12) / 1e12,
    nA,
    nB,
    reason: `${usedFisher ? 'Fisher exact' : 'χ² Yates'} one-sided (hướng cải thiện): before ${a}/${nA}=${Math.round(pBefore * 10000) / 10000} vs after ${c}/${nB}=${Math.round(pAfter * 10000) / 10000} → p=${pass ? '<' : '≥'} ${ADAPTATION_STATS_ALPHA} → ${pass ? 'CHO ÁP dụng' : 'CHẶN (bằng chứng cải thiện chưa đủ ý nghĩa)'}`,
  }
}

/**
 * Welch-t BỔ TRỢ trên biến liên tục (cycles/tokens). Lọc giá trị không hữu
 * hạn; nhóm nào < 2 mẫu → null (welchTTest cần ≥2). Two-sided p — chỉ làm
 * giàu log/statsJson, KHÔNG quyết định pass/block.
 */
export function evaluateContinuousEvidence(before: number[], after: number[]): ContinuousSupport | null {
  const a = before.filter(v => typeof v === 'number' && Number.isFinite(v))
  const b = after.filter(v => typeof v === 'number' && Number.isFinite(v))
  if (a.length < 2 || b.length < 2) return null
  const { t, p } = welchTTest(a, b)
  if (!Number.isFinite(t) || !Number.isFinite(p)) return null
  return {
    test: 'welch_t',
    t: Math.round(t * 1e12) / 1e12,
    p: Math.round(p * 1e12) / 1e12,
    nA: a.length,
    nB: b.length,
  }
}

/**
 * Env ADAPTATION_STATS_GATE — có CHẶN THẬT không (default OFF = log-only).
 * Quy ước parse giống parseRuntimeJudgesMode (P3-M3): trim + lowercase;
 * chuỗi rỗng/không đặt = KHÔNG bật (FB-Đợt5-R2-01: env rỗng phải là unset,
 * không được lọt qua thành giá trị 0/false giả).
 *
 * NEURAL-ARCH (2026-10-11): đọc RUNTIME qua tuning-store
 * (adaptation_stats_gate — STORE > ENV > 'off'; env '1'/'true' map 'on'
 * giữ nguyên ngữ nghĩa bản cũ). Tinh chỉnh được trên tab Kiến trúc Neural.
 */
export function isAdaptationStatsGateBlocking(): boolean {
  return getTuningEnum('adaptation_stats_gate') === 'on'
}

// ==================== DB WIRING (fail-open) ====================

/** Kết quả đầy đủ của lần đánh giá gate cho 1 cặp chiến lược. */
export interface AdaptationGateResult {
  decision: AdaptationStatsDecision
  /** Welch-t trên cycles của các session 2 nhóm (null khi không đủ) */
  continuous: ContinuousSupport | null
}

/** Cap phòng vệ khi đọc StrategyAdaptationLog (log tích luỹ dài hạn). */
const SAL_TAKE = 1000

/**
 * Row SAL có phải adaptation KHÔNG ĐƯỢC ÁP DỤNG THẬT không (statsJson.applied
 * === false)? Hai trường hợp: (a) gate ON chặn (decision block + không
 * merge); row này CHƯA từng áp dụng — successful của nó đo lường "không
 * chuyển chiến lược", KHÔNG phải hiệu quả của toStrategy → phải loại khỏi
 * evidence (FB-Đợt6-R2-01). Row KHÔNG có trường `applied` (cũ / schema
 * trước fix) mặc định ĐÃ áp dụng — mọi row trước đây đều được apply thật.
 */
export function isNotAppliedStatsJson(statsJson: string | null): boolean {
  if (!statsJson) return false
  try {
    const parsed = JSON.parse(statsJson) as { applied?: unknown }
    return parsed?.applied === false
  } catch {
    return false // JSON hỏng (row cũ) — coi như đã áp dụng (fail-open evidence đầy đủ)
  }
}

/**
 * Đánh giá gate cho cặp (fromStrategy → toStrategy) từ tiền sử
 * StrategyAdaptationLog (successful != null):
 *   - after  = outcome các row toStrategy = toStrategy  (session đã chạy chiến lược MỚI)
 *   - before = outcome các row toStrategy = fromStrategy (session đã chạy chiến lược CŨ)
 * Welch-t bổ trợ: cycles từ AgentRunRecord MỚI NHẤT có cycles của từng session
 * trong 2 nhóm.
 *
 * Fail-open: DB lỗi / không có gì → null (caller coi như KHÔNG có gate —
 * hành vi cũ nguyên vẹn). Read-only — chỉ đọc, mọi ghi do caller chủ động.
 *
 * Loại khỏi evidence: row successful=null (chưa chốt) và row KHÔNG được áp
 * dụng thật (statsJson.applied=false — gate ON chặn, FB-Đợt6-R2-01; riêng
 * log-only decision='block' VẪN áp dụng thật → vẫn là evidence hợp lệ).
 */
export async function evaluateAdaptationGateForPair(
  fromStrategy: string,
  toStrategy: string,
): Promise<AdaptationGateResult | null> {
  try {
    const rows = await db.strategyAdaptationLog.findMany({
      where: { successful: { not: null } },
      select: { toStrategy: true, successful: true, sessionId: true, statsJson: true },
      orderBy: { createdAt: 'asc' },
      take: SAL_TAKE,
    })

    const after: boolean[] = []
    const before: boolean[] = []
    const afterSessions = new Set<string>()
    const beforeSessions = new Set<string>()
    for (const row of rows) {
      if (row.successful === null) continue // defensible với type — where đã lọc
      if (isNotAppliedStatsJson(row.statsJson)) continue // FB-Đợt6-R2-01 — chưa từng áp dụng thật
      if (row.toStrategy === toStrategy) {
        after.push(row.successful)
        afterSessions.add(row.sessionId)
      } else if (row.toStrategy === fromStrategy) {
        before.push(row.successful)
        beforeSessions.add(row.sessionId)
      }
    }

    const decision = evaluateAdaptationEvidence(before, after)

    // Welch-t bổ trợ — cycles chạy mới nhất của từng session trong 2 nhóm
    let continuous: ContinuousSupport | null = null
    try {
      const allSessions = [...afterSessions, ...beforeSessions]
      if (allSessions.length > 0) {
        const runRows = await db.agentRunRecord.findMany({
          where: { sessionId: { in: allSessions }, cycles: { not: null } },
          select: { sessionId: true, cycles: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: SAL_TAKE * 4,
        })
        // Mỗi session lấy row MỚI NHẤT (findMany đã sort desc — set lần đầu là mới nhất)
        const latestCycles = new Map<string, number>()
        for (const r of runRows) {
          if (typeof r.cycles === 'number' && Number.isFinite(r.cycles) && !latestCycles.has(r.sessionId)) {
            latestCycles.set(r.sessionId, r.cycles)
          }
        }
        const cyclesAfter = [...afterSessions].map(s => latestCycles.get(s)).filter((v): v is number => typeof v === 'number')
        const cyclesBefore = [...beforeSessions].map(s => latestCycles.get(s)).filter((v): v is number => typeof v === 'number')
        continuous = evaluateContinuousEvidence(cyclesBefore, cyclesAfter)
      }
    } catch { /* bổ trợ fail-open — không có continuous vẫn đánh giá được */ }

    return { decision, continuous }
  } catch {
    return null // fail-open toàn phần — KHÔNG có gate khi DB lỗi
  }
}

/**
 * Lưu kết luận gate vào StrategyAdaptationLog.statsJson của row vừa tạo
 * (spec §P4-M1: statsJson = { test, p, nA, nB, decision } + `applied` ghi
 * thêm việc chiến lược CÓ được áp dụng thật không — log-only would-block vẫn
 * applied=true; gate ON chặn → applied=false, loại khỏi evidence sau này
 * FB-Đợt6-R2-01). Fail-open: lỗi DB nuốt im lặng (row vẫn hợp lệ — statsJson
 * nullable).
 */
export async function persistAdaptationStatsJson(
  logId: string,
  result: AdaptationGateResult,
  applied: boolean,
): Promise<void> {
  try {
    const payload = {
      test: result.decision.test,
      p: result.decision.p,
      nA: result.decision.nA,
      nB: result.decision.nB,
      decision: result.decision.pass ? 'pass' : 'block',
      applied,
      continuous: result.continuous ?? undefined,
    }
    await db.strategyAdaptationLog.update({
      where: { id: logId },
      data: { statsJson: JSON.stringify(payload) },
    })
  } catch {
    // fail-open — statsJson nullable, không được phép lỗi workflow
  }
}
