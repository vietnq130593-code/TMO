/**
 * OBS-P4 (BLUEPRINT-OBSERVATION-P1-P4 §C.6 — chốt §7 Task 23 2026-10-13)
 * ==========================================================================
 *
 * IMPACT TRACKER + META-HEALTH — job nền tick (precedent GoalLoopWorker:
 * setInterval + globalThis guard + unref, KHÔNG cron mới):
 *
 *   1. Impact pass — với mỗi TuningChangeLog entry đã ≥ 24h mà CHƯA có sự
 *      kiện impact.estimate: so sánh KPI snapshot NGÀY LIỀN TRƯỚC đổi vs
 *      NGÀY LIỀN SAU đổi (Q5 §7 chốt tại triển khai — KpiSnapshot hạt độ
 *      theo ngày 1 dòng/ngày/KPI nên cửa sổ "N sự kiện" không chiếu được;
 *      tra tối đa ±3 ngày mỗi bên, cần đủ 2 bên trong cửa sổ mới tính —
 *      FB-OBS-R1-01/R1-02: ±3 ngày + bỏ snapshot cùng ngày đổi) → ghi 1 sự
 *      kiện kind 'impact.estimate'. FRAMING TRUNG THỰC (RO-6): correlation
 *      window — KHÔNG claim nhân quả (nhiều thứ đổi song song).
 *   2. Health pass — phát 1 sự kiện kind 'obs.health' mỗi tick: queue/
 *      dropped/failed của ledger + trace (GAP-7 meta-health).
 *
 * Cờ `obs_impact` (off mặc định) — tick kiểm tra cờ MỖI vòng (bật là có
 * hiệu lực ngay, không cần restart). Cờ off → tick rỗng (rẻ). Output duy
 *      nhất của worker là SỰ KIỆN qua ledger — nên obs_ledger off → tick
 *      rỗng luôn (FB-OBS-R1-11: không quét dedup/KPI vô ích).
 * Mọi DB write trong tick fail-open — worker KHÔNG BAO GIỜ throw.
 */

import { db } from '@/lib/db'
import { getTuningEnum } from '@/lib/learning/tuning-store'
import { observeEvent, getObservationHealth, flushObservationQueue, isObsLedgerEnabled } from './ledger'
import { getTraceHealth } from './trace'
import { KPI_REGISTRY } from '@/lib/kpi/registry'

// ==================== HẰNG SỐ (doctrine #1 — nguồn §C.6 + §7 Q5 chốt) ====================

/** Chu kỳ tick (10 phút — precedent nhịp worker nền, không cron mới). */
export const OBS_IMPACT_TICK_MS = 600_000
/** Change phải ≥ 24h cũ mới chấm (đợi snapshot "ngày sau" tồn tại — §C.6). */
export const OBS_IMPACT_MIN_AGE_MS = 24 * 3600 * 1000
/** Tra snapshot trong ±3 ngày quanh change (Q5 §7 chốt — cửa sổ snapshot ngày). */
export const OBS_IMPACT_LOOK_DAYS = 3
/** Xử lý tối đa N change mỗi tick (chống burst — tick sau tiếp). */
export const OBS_IMPACT_BATCH = 20
/** z 1,96 cho CI 95% (approx normal — precedent meanCI @/lib/stats). */
const Z95 = 1.96

// ==================== PURE — ƯỚC LƯỢNG TÁC ĐỘNG 1 KPI (test r98) ====================

export interface KpiSnapshotLite {
  date: string // YYYY-MM-DD
  value: number
  sampleSize: number
}

export interface KpiImpactEstimate {
  kpi: string
  before: number
  beforeN: number
  after: number
  afterN: number
  delta: number
  /** CI 95% thô — CHỈ cho KPI rate:true trong KPI_REGISTRY (tỉ lệ nhị thức
   * part/total) + value ∈ [0,1] + n>0 (FB-OBS-R1-04: bỏ heuristic value∈[0,1]
   * vốn bắt nhầm KPI trung bình như eval_ndcg/eval_recall/verdict_f1); null còn lại */
  ciLow: number | null
  ciHigh: number | null
  direction: 'higher' | 'lower' | undefined
}

/**
 * So 2 snapshot (trước/sau) → delta + CI thô binomial-style cho rate KPI.
 * PURE — test pin r98 (bảng tay). CI = z·√(se²before + se²after) với
 * se = √(p(1−p)/n) mỗi bên — "hiệu ± CI thô từ sampleSize" (§C.6), KHÔNG
 * phải phép thử thống kê nghiêm ngặt (n=1 snapshot/ngày/bên).
 */
export function estimateKpiImpact(
  kpiKey: string,
  before: KpiSnapshotLite,
  after: KpiSnapshotLite,
  direction?: 'higher' | 'lower',
): KpiImpactEstimate {
  const delta = after.value - before.value
  // FB-OBS-R1-04: rate = KPI_REGISTRY đánh dấu rate:true (tỉ lệ nhị thức
  // part/total) — KHÔNG dùng heuristic value∈[0,1] (bắt nhầm KPI TRUNG BÌNH
  // nằm [0,1] như eval_ndcg/eval_recall/verdict_f1 → CI binomial sai mô
  // hình phương sai). Kèm guard dữ liệu (value∈[0,1] + n>0) — lạc quê → null.
  const reg = KPI_REGISTRY.find(k => k.key === kpiKey)
  const isRate =
    reg?.rate === true
    && before.value >= 0 && before.value <= 1 && after.value >= 0 && after.value <= 1
    && before.sampleSize > 0 && after.sampleSize > 0
  let ciLow: number | null = null
  let ciHigh: number | null = null
  if (isRate) {
    const seB = Math.sqrt((before.value * (1 - before.value)) / before.sampleSize)
    const seA = Math.sqrt((after.value * (1 - after.value)) / after.sampleSize)
    const half = Z95 * Math.sqrt(seB * seB + seA * seA)
    ciLow = delta - half
    ciHigh = delta + half
  }
  return {
    kpi: kpiKey,
    before: before.value,
    beforeN: before.sampleSize,
    after: after.value,
    afterN: after.sampleSize,
    delta,
    ciLow,
    ciHigh,
    direction,
  }
}

/** Format +N/N với dấu phẩy vi-VN, 4 chữ số lẻ (hiển thị summary — pure). */
export function formatImpactDelta(d: number): string {
  const s = d >= 0 ? '+' : ''
  return `${s}${d.toFixed(4).replace('.', ',')}`
}

// ==================== IMPACT PASS ====================

/** Ngày YYYY-MM-DD (UTC) của 1 Date — cùng format KpiSnapshot.date. */
export function kpiDateOf(t: Date): string {
  return t.toISOString().slice(0, 10)
}

/**
 * Chấm impact cho các TuningChangeLog đủ tuổi + chưa chấm. Trả số sự kiện
 * đã ghi. Dedup: mọi impact.estimate hiện có (payloadJson chứa changeLogId)
 * được load 1 lần rồi set-lookup.
 */
export async function computeImpactEstimates(): Promise<number> {
  // FB-OBS-R1-11: obs_ledger off → mọi observeEvent no-op — quét chỉ đốt DB
  // (dedup không bao giờ nhúng → rescan mãi mỗi tick) + written đếm giả.
  if (!isObsLedgerEnabled()) return 0
  const cutoff = new Date(Date.now() - OBS_IMPACT_MIN_AGE_MS)
  const candidates = await db.tuningChangeLog.findMany({
    where: { createdAt: { lte: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: 500, // giới hạn quét (prune TuningChangeLog giữ cap sẵn — đủ)
    select: { id: true, key: true, action: true, createdAt: true, fromEffectiveValue: true, toEffectiveValue: true },
  })
  if (candidates.length === 0) return 0

  // Dedup — changeLogId đã chấm (parse payload các sự kiện impact.estimate)
  const done = new Set<number>()
  const existing = await db.observationEvent.findMany({
    where: { kind: 'impact.estimate' },
    select: { payloadJson: true },
  })
  for (const row of existing) {
    try {
      const p = JSON.parse(row.payloadJson) as { changeLogId?: number }
      if (typeof p.changeLogId === 'number') done.add(p.changeLogId)
    } catch { /* payload rác — bỏ qua */ }
  }
  const pending = candidates.filter(c => !done.has(c.id)).slice(0, OBS_IMPACT_BATCH)
  if (pending.length === 0) return 0

  // Load TOÀN BỘ KpiSnapshot 1 lần (nhỏ — 1 dòng/ngày/KPI) rồi tra cửa sổ
  const snapshots = await db.kpiSnapshot.findMany({
    orderBy: { date: 'asc' },
    select: { date: true, kpi: true, value: true, sampleSize: true },
  })
  const byKpi = new Map<string, KpiSnapshotLite[]>()
  for (const s of snapshots) {
    const arr = byKpi.get(s.kpi) ?? []
    arr.push({ date: s.date, value: s.value, sampleSize: s.sampleSize })
    byKpi.set(s.kpi, arr)
  }
  const directionByKey = new Map(KPI_REGISTRY.map(k => [k.key, k.goal] as const))

  let written = 0
  for (const change of pending) {
    const kpis: KpiImpactEstimate[] = []
    for (const [kpiKey, arr] of byKpi) {
      const changeDay = kpiDateOf(change.createdAt)
      // FB-OBS-R1-01: cửa sổ ±LOOK ngày mỗi bên (Q5 §7 chốt — trước đây
      // OBS_IMPACT_LOOK_DAYS khai báo nhưng dead, snapshot cách 10 ngày vẫn chấm)
      const minDay = kpiDateOf(new Date(change.createdAt.getTime() - OBS_IMPACT_LOOK_DAYS * 24 * 3600_000))
      const maxDay = kpiDateOf(new Date(change.createdAt.getTime() + OBS_IMPACT_LOOK_DAYS * 24 * 3600_000))
      let before: KpiSnapshotLite | null = null
      let after: KpiSnapshotLite | null = null
      for (const s of arr) {
        if (s.date < changeDay) {
          // ngày liền TRƯỚC (gần nhất < changeDay) — chỉ nhận trong [minDay, changeDay)
          if (s.date >= minDay) before = s
        } else if (s.date === changeDay) {
          continue // FB-OBS-R1-02: cùng ngày đổi = dữ liệu trộn trước/sau — bỏ, tìm ngày KẾ (trước đây chặn cả KPI)
        } else {
          // snapshot đầu tiên > changeDay quyết định — trong maxDay mới nhận
          if (s.date <= maxDay) after = s
          break // sau đó chỉ xa hơn — dừng (arr sorted asc)
        }
        if (before && after) break
      }
      // cần đủ 2 bên TRONG cửa sổ ±LOOK ngày (Q5 §7 chốt)
      if (!before || !after) continue
      kpis.push(estimateKpiImpact(kpiKey, before, after, directionByKey.get(kpiKey)))
    }
    // Chỉ ghi khi có ít nhất 1 KPI đo được 2 bên
    if (kpis.length === 0) continue
    const top = kpis.slice(0, 3).map(k => `${k.kpi} ${formatImpactDelta(k.delta)}`).join(' · ')
    observeEvent({
      actor: 'system',
      kind: 'impact.estimate',
      summary: `Tác động ước lượng ${change.key} (${change.action}): ${top} — correlation, không claim nhân quả`,
      payload: {
        changeLogId: change.id,
        key: change.key,
        action: change.action,
        changedAt: change.createdAt.toISOString(),
        from: change.fromEffectiveValue,
        to: change.toEffectiveValue,
        window: {
          granularity: 'daily-snapshot',
          lookDays: OBS_IMPACT_LOOK_DAYS,
          note: 'so sánh KPI snapshot ngày liền trước vs liền sau change (tra ±3 ngày mỗi bên) — correlation window, KHÔNG phải nhân quả (nhiều thứ đổi song song)',
        },
        kpis,
      },
    })
    written++
  }
  if (written > 0) await flushObservationQueue()
  return written
}

// ==================== HEALTH PASS (GAP-7 — meta-health) ====================

/** Phát 1 sự kiện obs.health — trạng thái queue/drop/latency của chính ledger. */
export async function emitObservationHealth(): Promise<void> {
  const ledger = getObservationHealth()
  const trace = getTraceHealth()
  const dropTotal = ledger.dropped + trace.dropped
  observeEvent({
    actor: 'system',
    kind: 'obs.health',
    summary: `Ledger: ${ledger.written} ghi · queue ${ledger.queued} · drop ${dropTotal} · trễ ghi ${ledger.lastWriteLatencyMs}ms`,
    payload: {
      ledger: { ...ledger },
      trace: { ...trace },
      healthy: dropTotal === 0 && ledger.failed === 0,
    },
  })
  await flushObservationQueue()
}

// ==================== WORKER (tick precedent GoalLoopWorker) ====================

interface ObsImpactWorkerState {
  timer: ReturnType<typeof setInterval> | null
  running: boolean
  started: boolean
}

const globalForObsImpact = globalThis as unknown as { __tmoObsImpactWorker?: ObsImpactWorkerState }

function workerState(): ObsImpactWorkerState {
  if (!globalForObsImpact.__tmoObsImpactWorker) {
    globalForObsImpact.__tmoObsImpactWorker = { timer: null, running: false, started: false }
  }
  return globalForObsImpact.__tmoObsImpactWorker
}

/** Cờ obs_impact (STORE › ENV › DEFAULT=off) — check MỖI tick, hiệu lực ngay. */
export function isObsImpactEnabled(): boolean {
  try {
    return getTuningEnum('obs_impact') === 'on'
  } catch {
    return false
  }
}

async function tick(): Promise<void> {
  const st = workerState()
  if (st.running) return // tick trước chưa xong — bỏ (không xếp chồng)
  // FB-OBS-R1-11: output duy nhất của worker là SỰ KIỆN — obs_ledger off
  // thì tick rỗng (không quét candidates/dedup/KPI vô ích)
  if (!isObsImpactEnabled() || !isObsLedgerEnabled()) return
  st.running = true
  try {
    await computeImpactEstimates()
    await emitObservationHealth()
  } catch {
    // fail-open — worker không bao giờ throw làm chết interval
  } finally {
    st.running = false
  }
}

/**
 * Khởi động worker nền — globalThis guard chống double-register (HMR +
   gọi tay). Interval unref() để không giữ process (test/CLI thoát sạch).
 */
export function startObservationImpactWorker(): void {
  const st = workerState()
  if (st.started) return
  st.started = true
  st.timer = setInterval(() => {
    void tick()
  }, OBS_IMPACT_TICK_MS)
  // Chạy 1 vòng ngay lúc boot (đỡ chờ 10 phút đầu — vẫn fail-open)
  void tick()
  try {
    // Bun/Node Timer.unref tồn tại runtime — không giữ process (test/CLI thoát sạch)
    st.timer.unref()
  } catch {
    /* môi trường không có unref — chấp nhận giữ process (pm2 daemon) */
  }
  console.log(`[ObservationImpact] worker bắt đầu — tick ${OBS_IMPACT_TICK_MS / 1000}s (cờ obs_impact ${isObsImpactEnabled() ? 'ON' : 'off — tick rỗng'})`)
}

/** Dừng worker (test dọn dẹp). */
export function stopObservationImpactWorker(): void {
  const st = workerState()
  if (st.timer) {
    clearInterval(st.timer)
    st.timer = null
  }
  st.started = false
}
