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
 *   3. Task 26-BE thêm vào CÙNG tick (không timer mới): (a) GAP-1
 *      ensureDailyKpiSnapshots — KpiSnapshot hôm nay làm mới mỗi 2h + hôm
 *      qua final 1 lần nếu thiếu (nguyên liệu cho pass impact — xem
 *      kpi-snapshots.ts); (b) GAP-2 runAlertChecks — 3 rule cảnh báo chủ
 *      động stall/token-burn/job-stale (xem alerts.ts; chạy cả khi
 *      obs_ledger off — console.warn vẫn phát, sự kiện tự no-op).
 *
 * Cờ `obs_impact` (off mặc định) — tick kiểm tra cờ MỖI vòng (bật là có
 * hiệu lực ngay, không cần restart). Cờ off → tick rỗng (rẻ). Output duy
 *      nhất của worker là SỰ KIỆN qua ledger — nên obs_ledger off → tick
 *      rỗng luôn (FB-OBS-R1-11: không quét dedup/KPI vô ích).
 * Mọi DB write trong tick fail-open — worker KHÔNG BAO GIỜ throw.
 */

import { db } from '@/lib/db'
import { getTuningEnum, refreshTuningSnapshot } from '@/lib/learning/tuning-store'
import { observeEvent, getObservationHealth, flushObservationQueue, isObsLedgerEnabled } from './ledger'
import { getTraceHealth } from './trace'
import { KPI_REGISTRY } from '@/lib/kpi/registry'
// Task 26-BE (GAP-2) — alerts KHÔNG import ngược impact (không chu trình)
import { runAlertChecks } from './alerts'

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

/** Kết quả tra cửa sổ snapshot quanh 1 mốc đổi (P7 dùng chung với pass 1). */
export interface DailyImpactWindow {
  before: KpiSnapshotLite
  after: KpiSnapshotLite
}

/**
 * PURE (OBS-P7 — R34 tách từ pass 1 để 2 neo dùng chung): tìm snapshot NGÀY
 * LIỀN TRƯỚC vs NGÀY LIỀN SAU mốc changedAt trong cửa sổ ±LOOK ngày mỗi bên
 * (Q5 §7 chốt — FB-OBS-R1-01/R1-02: cùng ngày đổi bị bỏ, ngoài cửa sổ bị bỏ).
 * arr PHẢI sorted asc theo date. Không đủ 2 bên trong cửa sổ → null.
 */
export function findDailyImpactWindow(
  arr: KpiSnapshotLite[],
  changedAt: Date,
): DailyImpactWindow | null {
  const changeDay = kpiDateOf(changedAt)
  const minDay = kpiDateOf(new Date(changedAt.getTime() - OBS_IMPACT_LOOK_DAYS * 24 * 3600_000))
  const maxDay = kpiDateOf(new Date(changedAt.getTime() + OBS_IMPACT_LOOK_DAYS * 24 * 3600_000))
  let before: KpiSnapshotLite | null = null
  let after: KpiSnapshotLite | null = null
  for (const s of arr) {
    if (s.date < changeDay) {
      // ngày liền TRƯỚC (gần nhất < changeDay) — chỉ nhận trong [minDay, changeDay)
      if (s.date >= minDay) before = s
    } else if (s.date === changeDay) {
      continue // FB-OBS-R1-02: cùng ngày đổi = dữ liệu trộn trước/sau — bỏ, tìm ngày KẾ
    } else {
      // snapshot đầu tiên > changeDay quyết định — trong maxDay mới nhận
      if (s.date <= maxDay) after = s
      break // sau đó chỉ xa hơn — dừng (arr sorted asc)
    }
    if (before && after) break
  }
  if (!before || !after) return null
  return { before, after }
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
      // OBS-P7 (R34): tách findDailyImpactWindow dùng chung 2 neo (hành vi
      // nguyên vẹn FB-OBS-R1-01/R1-02 — r98 C1-C6 pin qua DB)
      const w = findDailyImpactWindow(arr, change.createdAt)
      if (!w) continue
      kpis.push(estimateKpiImpact(kpiKey, w.before, w.after, directionByKey.get(kpiKey)))
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

// ==================== IMPACT PASS 2 — NEO EVO-DEPLOY (OBS-P7 — R34) ====================

/**
 * Chấm impact cho các sự kiện `proposal.apply` (TRIỂN KHAI KIẾN TRÚC EVO —
 * OBS-P5 H4 phát) đủ tuổi ≥ 24h mà chưa chấm. FB-OBSV3-R1-01 (R35 fixbug):
 * CHỈ chấm sự kiện origin 'evo-deploy' (spec OBS-P7 "đo tác động TRIỂN KHAI
 * kiến trúc EVO") — deploy editor-draft (origin 'editor') vẫn hiện timeline
 * nhưng KHÔNG thành neo impact (trộn 2 loại deploy làm vỡ ngữ cảnh
 * correlation). Cùng cơ chế Q5 §7 như neo 1 (TuningChangeLog): snapshot ngày
 * liền trước vs liền sau (±3 ngày mỗi bên, cần đủ 2 bên). Framing trung
 * thực RO-6: correlation — KHÔNG claim nhân quả. Dedup theo `evoDeploySeq`
 * (seq sự kiện proposal.apply) trong payload impact.estimate đã có. Trả số
 * sự kiện đã ghi.
 */
export async function computeProposalApplyImpactEstimates(): Promise<number> {
  // FB-OBS-R1-11 precedent: obs_ledger off → không quét (dedup không nhúng
  // được → rescan mãi mỗi tick vô ích)
  if (!isObsLedgerEnabled()) return 0
  const cutoff = new Date(Date.now() - OBS_IMPACT_MIN_AGE_MS)
  const proposals = await db.observationEvent.findMany({
    where: { kind: 'proposal.apply', ts: { lte: cutoff } },
    orderBy: { ts: 'asc' },
    take: 200,
    select: { seq: true, ts: true, payloadJson: true },
  })
  if (proposals.length === 0) return 0

  // Dedup — evoDeploySeq đã chấm
  const done = new Set<number>()
  const existing = await db.observationEvent.findMany({
    where: { kind: 'impact.estimate' },
    select: { payloadJson: true },
  })
  for (const row of existing) {
    try {
      const p = JSON.parse(row.payloadJson) as { evoDeploySeq?: number }
      if (typeof p.evoDeploySeq === 'number') done.add(p.evoDeploySeq)
    } catch { /* payload rác — bỏ qua */ }
  }
  const pending = proposals.filter(p => !done.has(p.seq)).slice(0, OBS_IMPACT_BATCH)
  if (pending.length === 0) return 0

  // Load TOÀN BỘ KpiSnapshot 1 lần (nhỏ — 1 dòng/ngày/KPI)
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
  for (const prop of pending) {
    let meta: { brain?: string; version?: number; archSummary?: string | null; origin?: string; improved?: boolean } = {}
    try {
      meta = JSON.parse(prop.payloadJson) as typeof meta
    } catch { /* payload rác — vẫn chấm với meta rỗng (seq là khóa) */ }
    // FB-OBSV3-R1-01: neo P7 đo TRIỂN KHAI EVO — bỏ qua deploy editor-draft
    // (origin 'editor' / payload rác không origin) để không trộn 2 ngữ cảnh.
    if (meta.origin !== 'evo-deploy') continue
    const kpis: KpiImpactEstimate[] = []
    for (const [kpiKey, arr] of byKpi) {
      const w = findDailyImpactWindow(arr, prop.ts)
      if (!w) continue
      kpis.push(estimateKpiImpact(kpiKey, w.before, w.after, directionByKey.get(kpiKey)))
    }
    if (kpis.length === 0) continue
    const top = kpis.slice(0, 3).map(k => `${k.kpi} ${formatImpactDelta(k.delta)}`).join(' · ')
    observeEvent({
      actor: 'system',
      kind: 'impact.estimate',
      summary:
        `Tác động triển khai kiến trúc ${meta.brain ?? '?'} v${meta.version ?? '?'}${meta.origin === 'evo-deploy' ? ' (EVO)' : ''}: ${top}` +
        ' — correlation, không claim nhân quả',
      payload: {
        anchor: 'evo-deploy',
        evoDeploySeq: prop.seq,
        brain: meta.brain ?? null,
        version: meta.version ?? null,
        archSummary: meta.archSummary ?? null,
        origin: meta.origin ?? null,
        improved: meta.improved ?? null,
        changedAt: prop.ts.toISOString(),
        window: {
          granularity: 'daily-snapshot',
          lookDays: OBS_IMPACT_LOOK_DAYS,
          note: 'so sánh KPI snapshot ngày liền trước vs liền sau deploy (tra ±3 ngày mỗi bên) — correlation window, KHÔNG phải nhân quả (nhiều thứ đổi song song)',
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
  // FB-OBS-R1-11: obs_impact off → tick rỗng HOÀN TOÀN (impact + kpi-ensure
  // + alerts đều là việc của tick này — tắt worker là tắt tất cả, đúng precedent)
  if (!isObsImpactEnabled()) return
  st.running = true
  try {
    // Task 33 (§0b lượt 2): WAL passive checkpoint mỗi tick — đo thật
    // 2026-10-13 có cửa sổ WAL ~4MB (1043 trang) quanh các cụm ghi run-close
    // khiến truy vấn chậm hơn + góp phần socket-timeout (51 lỗi trong ngày).
    // PASSIVE không bao giờ chặn (nhún nếu có reader giữ snapshot cũ); tự
    // checkpoint mặc định chỉ chạy khi vượt 1000 trang — tick 10' giữ WAL
    // gọn thường xuyên hơn. Fail-open tuyệt đối.
    try {
      await db.$queryRawUnsafe('PRAGMA wal_checkpoint(PASSIVE)')
    } catch {
      /* fail-open — hygiene không được phép chết tick */
    }
    // Impact + KPI-snapshot (GAP-1) + health: output duy nhất là SỰ KIỆN (snapshot
    // là nguyên liệu cho impact) — obs_ledger off thì bỏ cả 3 (FB-OBS-R1-11:
    // không quét dedup/KPI vô ích + không đếm giả)
    if (isObsLedgerEnabled()) {
      await computeImpactEstimates()
      // OBS-P7 (R34) — neo impact thứ 2: triển khai kiến trúc (proposal.apply
      // → ACTIVE) — cùng cơ chế Q5 §7, anchor 'evo-deploy' trong payload.
      await computeProposalApplyImpactEstimates()
      // GAP-1 (Task 26-BE): ensure KpiSnapshot hôm nay (làm mới 2h) + hôm qua
      // (final 1 lần nếu thiếu) — dynamic import vì kpi-snapshots import
      // kpiDateOf từ impact này (chống chu trình tĩnh — tiền lệ ledger note)
      const { ensureDailyKpiSnapshots } = await import('./kpi-snapshots')
      await ensureDailyKpiSnapshots()
      await emitObservationHealth()
    }
    // GAP-2 (Task 26-BE): cảnh báo chủ động — chạy NGAY SAU pass impact; chạy
    // CẢ khi obs_ledger off (console.warn [OBS-ALERT] vẫn phát; sự kiện
    // obs.alert tự no-op ở ledger). Tự check cờ obs_alerts bên trong (off →
    // return ngay — rẻ).
    await runAlertChecks()
    // R4-ĐIỀU TRA (lượt 4) — XƯỞNG NHÃN Brain-A: auto-eval KB (cờ
    // auto_eval_kb tự gate bên trong; no-op khi đủ nhãn / trong chu kỳ nghỉ /
    // chưa seed case). Fail-open tuyệt đối — KHÔNG throw làm chết tick.
    await import('@/lib/eval/auto-eval')
      .then(m => m.maybeRunAutoKbEval())
      .catch(() => { /* fail-open */ })
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
  // Chạy 1 vòng ngay lúc boot — Task 33 (§0b lượt 2): WARM TUNING STORE
  // TRƯỚC. Đo thật 19:00 restart: snapshot tuning lazy-load qua request đầu
  // tiên — boot tick cũ đọc cờ off (mặc định) dù store DB đang on → tick đầu
  // LUÔN rỗng → 10 phút mù sau mỗi restart (obs.health/kpi/alerts trễ cả
  // tick). refreshTuningSnapshot nạp snapshot từ DB (fail-open — lỗi vẫn
  // tick như cũ, tick sau tự đọc lại).
  void refreshTuningSnapshot()
    .catch(() => { /* fail-open — warm lỗi thì tick với default như cũ */ })
    .then(() => tick())
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
