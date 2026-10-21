/**
 * ROUND-99 TESTS — Task 26-BE · GIAO THỨC QUAN SÁT HOÀN THIỆN
 * (GAP-1 + GAP-2 + train-progress bus — hợp đồng API chốt 26-RESTORE
 * 2026-10-14; GIAO_THUC_GIAM_SAT D1.1/D1.4 + HyperNAS §4.2-2b)
 *
 * Đo lường:
 *   A. Train-progress bus (THUẦN — không DB, tham số `now` cho TTL — "thiết kế
 *      bus test được thời gian"): start → running → done/failed với summary
 *      điền gì có sẵn; snapshot hết hạn sau 30' TTL (chỉ áp dụng sự kiện ĐÃ
 *      KẾT THÚC — running treo vĩnh viễn vẫn hiện); ring buffer ≤ 10 giữ
 *      MỚI NHẤT; end không start → no-op không throw; summary rác (NaN/
 *      Infinity) lọc sạch trung thực; snapshot shape ĐÚNG hợp đồng
 *      26-RESTORE (không thêm/bớt key — FE đang code theo).
 *   B. Pure thresholds (biên D1.1/D1.4/§4.2-2b — strict): stall > 15 phút;
 *      token-burn > 500K VÀ vừa kết thúc ≤ 15 phút (inclusive mép tick);
 *      heartbeat mồ côi > 30 phút; CronJob nextRunAt quá hạn > 60 phút
 *      (null/tương lai → không quá hạn).
 *   C. kinds.ts + TUNING_SPECS: OBS_KINDS 17 + obs.alert nhóm alert (chip
 *      amber — hợp đồng 26-RESTORE); cờ obs_alerts thứ 30 default off đủ
 *      trường, gắn node hist-feedback.
 *   D. runAlertChecks (DB cô lập, cờ on): stall phát obs.alert đủ payload
 *      post-mortem; run còn event 15' qua → KHÔNG stall; token-burn đúng
 *      ngưỡng + cửa sổ (run cũ ngoài 15' không báo lại); job-stale (a)
 *      BrainSearchRun heartbeat mồ côi + (b) CronJob quá hạn; dedup ≤ 1
 *      alert/(rule,targetId)/1h — tick 2 không phát lại; cờ obs_alerts off
 *      → 0 sự kiện; cờ obs_ledger off → console.warn [OBS-ALERT] VẪN phát
 *      nhưng KHÔNG ghi sự kiện (observeEvent tự gate).
 *   E. ensureDailyKpiSnapshots (GAP-1): lần đầu compute đủ hôm nay + hôm qua
 *      (KPI_REGISTRY.length dòng mỗi ngày); guard 2 GIỜ chặn compute lại
 *      (tick giữa 2 cửa chỉ tốn count); hết 2h → làm mới hôm nay; hôm qua
 *      ĐÃ ĐỦ → final 1 lần, KHÔNG đè số cuối (sentinel giữ nguyên).
 *   F. GET /api/observation/timeline (Task 26-BE): ?brain= lọc traces theo
 *      CỘT brain + events theo payload.brain (payload rách → loại, brain lạ
 *      → 200 rỗng fail-open); paginate hasMore/nextBefore ĐÚNG trên trang đã
 *      lọc; `total` trung thực ở tầng DB (KHÔNG tính payload.brain — JSDoc
 *      route); runId+brain AND cả hai; alerts24h đếm đúng 24h + KHÔNG tương
 *      tác filter brain.
 *   G. GET /api/brain/activity (pin nhẹ — r92-C pin chi tiết backprop 3 head
 *      surrogate đã có): training = bus MỌI brain (route KHÔNG lọc — FE tự so
 *      khớp); dormant → backprop null; policy ACTIVE → trung thực null-số +
 *      label giải thích (KHÔNG có nhãn thật cho 1 run riêng lẻ).
 *
 * DB CÔ LẬP qua preload (tests/db-isolation-preload.ts) — cleanup afterAll
 * pattern r92/r95/r98. Bus + dedup là STATE PROCESS (globalThis) — reset ở
 * beforeAll/afterAll để không rò sang file test khác (bun test 1 process).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '@/lib/db'
// A — train-progress bus (THUẦN — không đụng DB)
import {
  trainProgressStart, trainProgressEnd, trainProgressSnapshot, trainProgressRecent,
  trainProgressReset, TRAIN_PROGRESS_TTL_MS, TRAIN_PROGRESS_RING,
} from '@/lib/brain/train-progress'
// B/D — alerts (pure + rule engine)
import {
  shouldAlertStall, shouldAlertTokenBurn, isHeartbeatStale, shouldAlertCronOverdue,
  runAlertChecks, isObsAlertsEnabled, resetAlertDedupState,
  ALERT_STALL_AFTER_MS, ALERT_TOKEN_BURN_LIMIT, ALERT_TOKEN_BURN_WINDOW_MS,
  ALERT_HEARTBEAT_STALE_MS, ALERT_CRON_OVERDUE_MS, ALERT_DEDUP_WINDOW_MS,
  ALERT_ORPHAN_AFTER_MS,
} from '@/lib/observation/alerts'
// C — kinds + spec
import { OBS_KINDS, OBS_GROUP_CLASSES, obsKindDef } from '@/lib/observation/kinds'
import { TUNING_SPECS, getTuningSpec } from '@/lib/learning/neural-types'
// D — ledger (đồng bộ queue + cờ)
import { flushObservationQueue } from '@/lib/observation/ledger'
import { setTuningValue, resetTuningValue, refreshTuningSnapshot } from '@/lib/learning/tuning-store'
// E — GAP-1 kpi-snapshots
import { ensureDailyKpiSnapshots, resetKpiEnsureGuard, KPI_ENSURE_EVERY_MS } from '@/lib/observation/kpi-snapshots'
import { kpiDateOf } from '@/lib/observation/impact'
import { KPI_REGISTRY } from '@/lib/kpi/registry'
// F — timeline route
import { GET as GETTimeline } from '@/app/api/observation/timeline/route'
// G — activity route + MLP (seed bản policy active)
import { GET as GETActivity } from '@/app/api/brain/activity/route'
import { MLP } from '@/lib/brain/mlp'
import { policyFeatureNames } from '@/lib/brain/brains/policy'

const MIN = 60_000
const callTimeline = (q: string) => GETTimeline(new Request(`http://t/api/observation/timeline${q}`))
const activity = (brain: string) =>
  GETActivity(new Request(`http://t/api/brain/activity?brain=${brain}`)).then(async r => {
    expect(r.status).toBe(200)
    return (await r.json()) as {
      ok: boolean
      status: 'active' | 'dormant'
      backprop: { deltas: number[][] | null; yTrue: number[] | null; loss: number | null; label: string | null } | null
      training: {
        brain: string; head: string | null; status: 'running' | 'done' | 'failed'
        startedAt: string; endedAt: string | null
        epochsRun: number | null; finalLoss: number | null; gradAbsMean: number[] | null
      } | null
    }
  })

/** Payload obs.alert đã parse (payloadJson luôn JSON hợp lệ từ alerts.ts). */
interface AlertPayload {
  rule: string
  targetId: string
  runId?: string | null
  agentName?: string | null
  stalledMinutes?: number
  tokensUsed?: number
  status?: string | null
  kind?: string
  staleMinutes?: number
  overdueMinutes?: number
  [k: string]: unknown
}

async function alertPayloads(): Promise<AlertPayload[]> {
  const rows = await db.observationEvent.findMany({ where: { kind: 'obs.alert' }, orderBy: { seq: 'asc' } })
  return rows.map(r => JSON.parse(r.payloadJson) as AlertPayload)
}

/** Seed 1 AgentRunRecord (D — GIAO_THUC_GIAM_SAT: AgentRunRecord KHÔNG có
 *  updatedAt — mốc hoạt động cuối của run running = createdAt, xem alerts.ts). */
async function seedRun(o: {
  runId: string
  status: string
  ageMs: number
  agentName?: string
  tokensUsed?: number
  complete?: boolean
  endedAgeMs?: number
}): Promise<void> {
  const now = Date.now()
  await db.agentRunRecord.create({
    data: {
      sessionId: 'r99-obs-alerts',
      runId: o.runId,
      agentName: o.agentName ?? 'Alpha',
      status: o.status,
      tokensUsed: o.tokensUsed ?? null,
      complete: o.complete ?? null,
      startedAt: new Date(now - o.ageMs - 60_000),
      createdAt: new Date(now - o.ageMs),
      completedAt: o.endedAgeMs !== undefined ? new Date(now - o.endedAgeMs) : null,
    },
  })
}

beforeAll(async () => {
  // ENV layer: ledger on (D ghi sự kiện thật qua ledger); cờ mới mặc định off
  process.env.OBS_LEDGER = 'on'
  delete process.env.OBS_ALERTS
  delete process.env.OBS_BRAIN_TRACE
  delete process.env.OBS_IMPACT
  delete process.env.UI_OBSERVATION
  await db.tuningParam.deleteMany({
    where: { key: { in: ['obs_ledger', 'obs_brain_trace', 'obs_impact', 'ui_observation', 'obs_alerts'] } },
  })
  await refreshTuningSnapshot()
  // State process — reset cô lập (bun test 1 process với r92/r95/r96/r98)
  resetAlertDedupState()
  resetKpiEnsureGuard()
  trainProgressReset()
  // Dọn bảng mình dùng (DB bản copy /tmp của preload — không đụng DB app)
  await db.observationEvent.deleteMany({})
  await db.agentRunRecord.deleteMany({})
  await db.brainSearchRun.deleteMany({})
  await db.cronJob.deleteMany({})
  await db.kpiSnapshot.deleteMany({})
  await db.brainInferenceTrace.deleteMany({})
  await db.brainModel.deleteMany({
    where: { brain: { in: ['calibration_v3', 'surrogate', 'policy'] } },
  })
})

afterAll(async () => {
  delete process.env.OBS_LEDGER
  delete process.env.OBS_ALERTS
  delete process.env.OBS_BRAIN_TRACE
  delete process.env.OBS_IMPACT
  delete process.env.UI_OBSERVATION
  for (const k of ['obs_ledger', 'obs_brain_trace', 'obs_impact', 'ui_observation', 'obs_alerts']) {
    try { await resetTuningValue(k) } catch { /* chưa set — bỏ */ }
  }
  await refreshTuningSnapshot()
  resetAlertDedupState()
  resetKpiEnsureGuard()
  trainProgressReset()
  await db.observationEvent.deleteMany({})
  await db.agentRunRecord.deleteMany({})
  await db.brainSearchRun.deleteMany({})
  await db.cronJob.deleteMany({})
  await db.kpiSnapshot.deleteMany({})
  await db.brainInferenceTrace.deleteMany({})
  await db.brainModel.deleteMany({
    where: { brain: { in: ['calibration_v3', 'surrogate', 'policy'] } },
  })
})

// ==================== A. Train-progress bus (THUẦN — tham số now) ====================

describe('r99 · A — train-progress bus (in-memory, không DB)', () => {
  test('A1 start → running; snapshot shape ĐÚNG hợp đồng 26-RESTORE (không thêm/bớt key)', () => {
    trainProgressReset()
    trainProgressStart('calibration_v3', null, 1_000)
    const snap = trainProgressSnapshot(2_000)
    expect(snap).not.toBeNull()
    expect(snap!.brain).toBe('calibration_v3')
    expect(snap!.head).toBeNull()
    expect(snap!.status).toBe('running')
    expect(snap!.startedAt).toBe(new Date(1_000).toISOString())
    expect(snap!.endedAt).toBeNull()
    expect(snap!.epochsRun).toBeNull()
    expect(snap!.finalLoss).toBeNull()
    expect(snap!.gradAbsMean).toBeNull()
    // pin shape — FE đang code theo đúng các key này (26-RESTORE)
    expect(Object.keys(snap!).sort()).toEqual(
      ['brain', 'endedAt', 'epochsRun', 'finalLoss', 'gradAbsMean', 'head', 'startedAt', 'status'],
    )
  })

  test('A2 end ok → done + summary từ result (điền gì có sẵn); endedAt ISO', () => {
    trainProgressReset()
    trainProgressStart('calibration_v3', null, 1_000)
    trainProgressEnd(
      'calibration_v3', true,
      { epochsRun: 7, finalLoss: 0.25, gradAbsMean: [0.1, 0.2] },
      undefined, 3_000,
    )
    const snap = trainProgressSnapshot(3_500)
    expect(snap!.status).toBe('done')
    expect(snap!.epochsRun).toBe(7)
    expect(snap!.finalLoss).toBe(0.25)
    expect(snap!.gradAbsMean).toEqual([0.1, 0.2])
    expect(snap!.endedAt).toBe(new Date(3_000).toISOString())
  })

  test('A3 TTL 30 phút — sự kiện kết thúc quá 30\' → snapshot null (biên inclusive)', () => {
    trainProgressReset()
    trainProgressStart('surrogate', null, 1_000)
    trainProgressEnd('surrogate', true, undefined, undefined, 3_000)
    expect(TRAIN_PROGRESS_TTL_MS).toBe(30 * 60_000) // pin hợp đồng 26-RESTORE
    // đúng mép 30' (3_000 + TTL): KHÔNG quá — vẫn hiện
    expect(trainProgressSnapshot(3_000 + TRAIN_PROGRESS_TTL_MS)).not.toBeNull()
    // +1ms quá TTL → null
    expect(trainProgressSnapshot(3_000 + TRAIN_PROGRESS_TTL_MS + 1)).toBeNull()
  })

  test('A4 running KHÔNG hết hạn — TTL chỉ áp cho sự kiện đã kết thúc', () => {
    trainProgressReset()
    trainProgressStart('policy', null, 10_000)
    // treo 10 tiếng vẫn hiện (lượt train đang chạy — FE boost hạt vàng)
    const snap = trainProgressSnapshot(10_000 + 10 * 3600_000)
    expect(snap).not.toBeNull()
    expect(snap!.status).toBe('running')
  })

  test('A5 end !ok → failed; reason ở ring (nội bộ) KHÔNG lộ vào snapshot hợp đồng', () => {
    trainProgressReset()
    trainProgressStart('surrogate', 'tokens', 5_000)
    trainProgressEnd('surrogate', false, undefined, 'lỗi test A5', 6_000)
    const snap = trainProgressSnapshot(6_500)
    expect(snap!.status).toBe('failed')
    expect(snap!.endedAt).toBe(new Date(6_000).toISOString())
    expect(Object.keys(snap!)).not.toContain('reason') // shape hợp đồng không có reason
    // ring nội bộ VẪN lưu reason cho debug (mục 1)
    const ring = trainProgressRecent()
    expect(ring).toHaveLength(1)
    expect(ring[0].reason).toBe('lỗi test A5')
  })

  test('A6 ring buffer ≤ 10 — giữ 10 sự kiện GẦN NHẤT', () => {
    trainProgressReset()
    expect(TRAIN_PROGRESS_RING).toBe(10)
    for (let i = 1; i <= 12; i++) {
      trainProgressStart('policy', `h${i}`, 100 + i)
    }
    const ring = trainProgressRecent()
    expect(ring).toHaveLength(10)
    expect(ring[0].head).toBe('h3') // 2 sự kiện cũ nhất rơi khỏi ring
    expect(ring[9].head).toBe('h12') // mới nhất ở cuối
    // snapshot = sự kiện gần nhất (h12 — running)
    const snap = trainProgressSnapshot(200)
    expect(snap!.head).toBe('h12')
    expect(snap!.status).toBe('running')
  })

  test('A7 end không có start khớp → no-op KHÔNG throw (fail-open tuyệt đối)', () => {
    trainProgressReset()
    expect(() => trainProgressEnd('policy', true)).not.toThrow()
    expect(() => trainProgressEnd('surrogate', false)).not.toThrow()
    expect(trainProgressSnapshot()).toBeNull()
  })

  test('A8 summary rác (NaN/Infinity) lọc sạch — điền gì CÓ SẠN, không chế tạo', () => {
    trainProgressReset()
    trainProgressStart('calibration_v3', null, 1)
    trainProgressEnd(
      'calibration_v3', true,
      { epochsRun: Number.NaN, finalLoss: Number.POSITIVE_INFINITY, gradAbsMean: [0.5, Number.NaN, 2] },
      undefined, 2,
    )
    const snap = trainProgressSnapshot(3)
    expect(snap!.epochsRun).toBeNull() // NaN không hữu hạn → bỏ
    expect(snap!.finalLoss).toBeNull() // Infinity → bỏ
    expect(snap!.gradAbsMean).toEqual([0.5, 2]) // NaN giữa mảng lọc, giữ số hữu hạn
  })
})

// ==================== B. Pure thresholds — biên D1.1/D1.4/§4.2-2b (strict) ====================

describe('r99 · B — pure thresholds (r99 test trực tiếp — xem alerts.ts)', () => {
  test('B1 shouldAlertStall — D1.1 > 15 phút strict', () => {
    expect(ALERT_STALL_AFTER_MS).toBe(15 * 60_000)
    const now = 10 * 3600_000
    expect(shouldAlertStall(now - 15 * MIN, now)).toBe(false) // đúng 15' — chưa "cũ hơn 15'"
    expect(shouldAlertStall(now - 15 * MIN - 1, now)).toBe(true) // +1ms qua ngưỡng
    expect(shouldAlertStall(now - 14 * MIN, now)).toBe(false)
    expect(shouldAlertStall(now - 16 * MIN, now)).toBe(true)
  })

  test('B2 shouldAlertTokenBurn — D1.4 > 500K strict + cửa sổ 15 phút (inclusive mép tick)', () => {
    expect(ALERT_TOKEN_BURN_LIMIT).toBe(500_000)
    expect(ALERT_TOKEN_BURN_WINDOW_MS).toBe(15 * 60_000)
    const now = 10 * 3600_000
    expect(shouldAlertTokenBurn(500_000, now - 5 * MIN, now)).toBe(false) // đúng 500K — chưa vượt
    expect(shouldAlertTokenBurn(500_001, now - 5 * MIN, now)).toBe(true)
    // kết thúc đúng mép 15' vẫn báo (run kết thúc sát tick không bị lọt)
    expect(shouldAlertTokenBurn(600_000, now - 15 * MIN, now)).toBe(true)
    expect(shouldAlertTokenBurn(600_000, now - 15 * MIN - 1, now)).toBe(false) // ngoài cửa sổ
    expect(shouldAlertTokenBurn(600_000, now + 5 * MIN, now)).toBe(false) // mốc tương lai (dữ liệu rác)
  })

  test('B3 isHeartbeatStale — HyperNAS §4.2-2b > 30 phút strict', () => {
    expect(ALERT_HEARTBEAT_STALE_MS).toBe(30 * 60_000)
    const now = 10 * 3600_000
    expect(isHeartbeatStale(now - 30 * MIN, now)).toBe(false)
    expect(isHeartbeatStale(now - 30 * MIN - 1, now)).toBe(true)
    expect(isHeartbeatStale(now - 29 * MIN, now)).toBe(false)
  })

  test('B4 shouldAlertCronOverdue — quá hạn > 60 phút; null/tương lai → false', () => {
    expect(ALERT_CRON_OVERDUE_MS).toBe(60 * 60_000)
    const now = 10 * 3600_000
    expect(shouldAlertCronOverdue(null, now)).toBe(false)
    expect(shouldAlertCronOverdue(now + 30 * MIN, now)).toBe(false) // chưa đến giờ chạy
    expect(shouldAlertCronOverdue(now - 60 * MIN, now)).toBe(false) // đúng 60' — chưa quá hạn
    expect(shouldAlertCronOverdue(now - 60 * MIN - 1, now)).toBe(true)
    // pin dedup: ≤ 1 alert/(rule,targetId)/1h (hợp đồng 26-BE mục 4)
    expect(ALERT_DEDUP_WINDOW_MS).toBe(60 * 60_000)
  })
})

// ==================== C. kinds + TUNING_SPECS (GAP-2 khai báo) ====================

describe('r99 · C — kinds obs.alert + cờ obs_alerts (TUNING_SPECS thứ 30)', () => {
  test('C1 OBS_KINDS 27 + obs.alert nhóm alert + class amber (hợp đồng 26-RESTORE)', () => {
    expect(OBS_KINDS.length).toBe(28) // PIN UPDATE KPI#2 (trả nợ 2026-10-21): 27 → 28 (kpi.tx — snapshot p95 interactive tx mỗi 1000 write, nhóm impact) // PIN UPDATE §7.10 (2026-10-21): 25 → 27 (mem.soft_tier + mem.boot_grace — nhóm impact, đồng bộ pin r95-H6/r122-A1) // PIN UPDATE R34 OBS-V3: 19 → 25 (6 kind mới: eval.run + kb.consult + learn.escalate + adapt.escalate + model.failover + chat.fastpath) // PIN UPDATE R5: 18 → 19 (model.sync — đồng bộ model free, Đài quan sát thấy diff catalog)
    const def = obsKindDef('obs.alert')
    expect(def).not.toBeNull()
    expect(def!.group).toBe('alert')
    expect(def!.label).toBe('Cảnh báo quan sát')
    // R5 — model.sync nhóm tuning
    const syncDef = obsKindDef('model.sync')
    expect(syncDef?.group).toBe('tuning')
    // group class amber — đúng token hợp đồng 26-RESTORE
    expect(OBS_GROUP_CLASSES.alert).toBe('bg-amber-500/15 text-amber-300 border-amber-500/30')
    // map class phủ ĐỦ mọi nhóm đang dùng (thiếu nhóm → chip UI vỡ)
    const groups = [...new Set(OBS_KINDS.map(k => k.group))]
    for (const g of groups) expect(typeof OBS_GROUP_CLASSES[g]).toBe('string')
  })

  test('C2 spec obs_alerts — default off, đủ trường, gắn node hist-feedback (soi obs_impact)', () => {
    expect(TUNING_SPECS.length).toBe(36) // PIN UPDATE R24-c EVO-P4: 34 → 36 (brain_evolve + brain_search_global) // PIN UPDATE R4: 30 → 31 (cờ auto_eval_kb xưởng nhãn Brain-A) · PIN UPDATE R20 BRAIN-D1: 31 → 32 (cờ kb_consult_log LOG-ONLY) · PIN UPDATE R24-b Brain-D ghost: 32 → 34 (2 cờ kill-switch runtime_knowledge/knowledge_organ_strategy)
    const spec = getTuningSpec('obs_alerts')
    expect(spec).toBeDefined()
    expect(spec!.type).toBe('enum')
    expect(spec!.enumValues).toEqual(['off', 'on'])
    expect(spec!.default).toBe('off') // off mặc định — quan sát chủ động phải bật tay
    expect(spec!.envKey).toBe('OBS_ALERTS')
    expect(spec!.nodeId).toBe('hist-feedback') // cùng node 4 cờ obs còn lại
    expect(spec!.description).toContain('stall')
    expect(spec!.description).toContain('500K')
    expect(spec!.description).toContain('30 phút')
    // ENV xóa + STORE dọn (beforeAll) → resolve default off
    expect(isObsAlertsEnabled()).toBe(false)
  })
})

// ==================== D. runAlertChecks — rule engine (DB cô lập) ====================

describe('r99 · D — runAlertChecks (3 rule + dedup + cờ)', () => {
  test('D1 STALL (D1.1) — run đóng băng 20\' phát obs.alert đủ payload; run còn event 15\' qua → KHÔNG', async () => {
    // bật cờ (STORE layer — hiệu lực ngay không restart)
    await setTuningValue('obs_alerts', 'on')
    await refreshTuningSnapshot()
    expect(isObsAlertsEnabled()).toBe(true)
    resetAlertDedupState() // cô lập dedup in-memory
    // setTuningValue phát flag.flip qua ledger (tuning-store OBS-P1 hook) —
    // flush cho deterministic trước khi seed trực tiếp DB
    await flushObservationQueue()

    // run đóng băng: running, createdAt 20' trước, KHÔNG event nào 15' qua
    await seedRun({ runId: 'run_stall_1', status: 'running', ageMs: 20 * MIN, agentName: 'Opus' })
    // run còn hoạt động: running 20' trước NHƯNG có event 2' trước
    await seedRun({ runId: 'run_active_1', status: 'running', ageMs: 20 * MIN })
    // seq = MAX+1 (setTuningValue bên trên đã phát flag.flip seq 1 qua ledger
    // — không hardcode: ledger single-writer cấp MAX(seq)+1, seed phải theo)
    const mx = (await db.observationEvent.findFirst({ orderBy: { seq: 'desc' } }))?.seq ?? 0
    await db.observationEvent.create({
      data: {
        seq: mx + 1, actor: 'agent:Alpha', kind: 'run.start', runId: 'run_active_1',
        summary: 'vẫn hoạt động', payloadJson: '{}', ts: new Date(Date.now() - 2 * MIN),
      },
    })

    await runAlertChecks()

    // R4-ĐIỀU TRA (lượt 4): DB test là BẢN COPY production — rule 5
    // brain-label-starvation có thể phát THẬT cùng lúc (58 eval case thật
    // + 0 EvalResult là điều kiện alert đúng!) → filter theo rule như D3
    // thay vì assert tổng (chỉ stall rule được assert ở đây).
    const alerts = (await alertPayloads()).filter(p => p.rule === 'stall')
    expect(alerts).toHaveLength(1) // chỉ stall — run_active_1 có event gần nên bỏ
    const a = alerts[0]
    expect(a.rule).toBe('stall')
    expect(a.targetId).toBe('run_stall_1')
    expect(a.agentName).toBe('Opus')
    expect(a.stalledMinutes).toBe(20)
    expect(a.protocol).toContain('D1.1')
    // ObserveEventInput có runId → điền — sự kiện gắn kim tuyến đúng run
    const row = await db.observationEvent.findFirst({ where: { kind: 'obs.alert' } })
    expect(row?.runId).toBe('run_stall_1')
    expect(row?.actor).toBe('system:alerts')
  })

  test('D2 dedup ≤ 1 alert/(rule,runId)/1h — tick 2 không phát lại stall', async () => {
    const before = await db.observationEvent.count({ where: { kind: 'obs.alert' } })
    await runAlertChecks() // run_stall_1 vẫn stalled 20+' — nhưng đã alert < 1h
    const after = await db.observationEvent.count({ where: { kind: 'obs.alert' } })
    expect(after).toBe(before) // không phát lại (query layer thấy sự kiện 1h qua)
  })

  test('D3 TOKEN-BURN (D1.4) — > 500K vừa kết thúc phát; ngoài cửa sổ 15\' / dưới ngưỡng → bỏ', async () => {
    // 3 run kết thúc: burn (600K, 5' trước — BÁO) · burn_old (600K, 40' trước
    // — run cũ không báo lại sau restart) · burn_low (400K, 5' — dưới ngưỡng)
    await seedRun({ runId: 'run_burn_1', status: 'completed', ageMs: 5 * MIN, endedAgeMs: 5 * MIN, tokensUsed: 600_000, complete: true })
    await seedRun({ runId: 'run_burn_old', status: 'completed', ageMs: 40 * MIN, endedAgeMs: 40 * MIN, tokensUsed: 600_000, complete: true })
    await seedRun({ runId: 'run_burn_low', status: 'failed', ageMs: 5 * MIN, endedAgeMs: 5 * MIN, tokensUsed: 400_000, complete: false })

    await runAlertChecks()

    const burns = (await alertPayloads()).filter(p => p.rule === 'token-burn')
    expect(burns).toHaveLength(1) // chỉ run_burn_1
    expect(burns[0].targetId).toBe('run_burn_1')
    expect(burns[0].tokensUsed).toBe(600_000)
    expect(burns[0].status).toBe('completed')
    expect(burns[0].threshold).toBe(500_000)
    expect(burns[0].protocol).toContain('D1.4')
  })

  test('D4 JOB-STALE — (a) BrainSearchRun mồ côi 45\' (§4.2-2b) + (b) CronJob quá hạn 90\'', async () => {
    await db.brainSearchRun.create({
      data: {
        brain: 'surrogate', status: 'running', seed: 42,
        heartbeatAt: new Date(Date.now() - 45 * MIN),
        startedAt: new Date(Date.now() - 46 * MIN),
        dataFingerprint: 'r99-test', inputMode: 'runs-features',
        candidatesMax: 24, wallMsMax: 600_000,
      },
    })
    const cron = await db.cronJob.create({
      data: {
        expression: '*/5 * * * *', taskPrompt: 'r99 test cron task',
        enabled: true, status: 'active',
        nextRunAt: new Date(Date.now() - 90 * MIN),
      },
    })

    await runAlertChecks()

    const jobs = (await alertPayloads()).filter(p => p.rule === 'job-stale')
    expect(jobs).toHaveLength(2)
    const search = jobs.find(j => j.kind === 'brain_search_run')
    expect(search).toBeDefined()
    expect(search!.targetId).toContain('brain_search_run:')
    expect(search!.brain).toBe('surrogate')
    expect(search!.staleMinutes).toBe(45)
    expect(String(search!.source)).toContain('§4.2-2b')
    const cronAlert = jobs.find(j => j.kind === 'cron_job')
    expect(cronAlert).toBeDefined()
    expect(cronAlert!.targetId).toBe(`cron_job:${cron.id}`)
    expect(cronAlert!.overdueMinutes).toBe(90)
    expect(cronAlert!.expression).toBe('*/5 * * * *')
  })

  test('D5 cờ obs_alerts off → 0 sự kiện mới (tick rỗng — hiệu lực ngay không restart)', async () => {
    await resetTuningValue('obs_alerts')
    await refreshTuningSnapshot()
    expect(isObsAlertsEnabled()).toBe(false)
    resetAlertDedupState() // dọn dedup — nếu cờ không chặn thì stall mới SẼ phát
    await seedRun({ runId: 'run_stall_2', status: 'running', ageMs: 20 * MIN })

    const before = await db.observationEvent.count({ where: { kind: 'obs.alert' } })
    await runAlertChecks()
    const after = await db.observationEvent.count({ where: { kind: 'obs.alert' } })
    expect(after).toBe(before) // cờ off → return NGAY — không rule nào chạy
  })

  test('D6 obs_ledger off → console.warn [OBS-ALERT] VẪN phát nhưng KHÔNG ghi sự kiện', async () => {
    // bật lại obs_alerts; TẮT obs_ledger (env xóa + STORE rỗng → default off)
    await setTuningValue('obs_alerts', 'on')
    await refreshTuningSnapshot()
    delete process.env.OBS_LEDGER
    await refreshTuningSnapshot()
    resetAlertDedupState()
    await seedRun({ runId: 'run_stall_3', status: 'running', ageMs: 20 * MIN })

    const before = await db.observationEvent.count({ where: { kind: 'obs.alert' } })
    // bắt console.warn (emitAlert luôn warn trước khi observeEvent no-op)
    const origWarn = console.warn
    const warns: unknown[][] = []
    console.warn = (...args: unknown[]) => { warns.push(args) }
    try {
      await runAlertChecks()
    } finally {
      console.warn = origWarn
      // trả lại env cho các describe sau (F seed qua ledger)
      process.env.OBS_LEDGER = 'on'
      await refreshTuningSnapshot()
    }
    // console.warn vẫn phát (cảnh báo không phụ thuộc ledger)
    expect(warns.length).toBeGreaterThanOrEqual(1)
    expect(warns.some(w => w[0] === '[OBS-ALERT]' && String(w[1]) === 'stall')).toBe(true)
    // nhưng sự kiện KHÔNG được ghi — observeEvent tự gate theo obs_ledger
    const after = await db.observationEvent.count({ where: { kind: 'obs.alert' } })
    expect(after).toBe(before)
  })

  test('D7 ORPHAN-SWEEP (Task 32 — D1.2) — mồ côi >30\' KHÔNG còn trong bộ nhớ → failed/crashed + obs.alert; run sống trong bộ nhớ / run <30\' → KHÔNG đụng', async () => {
    // 3 record running:
    //  - run_orphan_1: 40' tuổi, KHÔNG trong registry → PHẢI bị sweep (failed/crashed)
    //  - run_live_1:   40' tuổi, TRONG registry (goal-loop đang chạy LLM call dài) → phải còn nguyên 'running'
    //  - run_young_1:  20' tuổi, không trong registry → dưới ngưỡng 30' → phải còn 'running'
    await seedRun({ runId: 'run_orphan_1', status: 'running', ageMs: 40 * MIN, agentName: 'MEGATRON' })
    await seedRun({ runId: 'run_live_1', status: 'running', ageMs: 40 * MIN, agentName: 'Omega' })
    await seedRun({ runId: 'run_young_1', status: 'running', ageMs: 20 * MIN, agentName: 'Opus' })
    // Đưa run_live_1 vào bộ nhớ tracker (giống goal-loop thật): dbPersistBy 'caller'
    // → endAgentRun KHÔNG tạo thêm row DB (giữ test sạch — không đụng seed)
    const { startAgentRun, endAgentRun, isRunIdActiveInMemory } = await import('@/lib/agent-run-tracker')
    startAgentRun({ sessionId: 'r99-obs-alerts', agentName: 'Omega', runId: 'run_live_1', dbPersistBy: 'caller' })
    expect(isRunIdActiveInMemory('run_live_1')).toBe(true)
    expect(isRunIdActiveInMemory('run_orphan_1')).toBe(false)
    expect(isRunIdActiveInMemory(null)).toBe(false) // fail-open nhánh an toàn
    // flush run.start vào DB để stall rule không đụng run_live_1 (deterministic)
    await flushObservationQueue()

    await runAlertChecks()

    // (1) orphan bị đóng sổ: failed/crashed + completedAt đặt
    const orphan = await db.agentRunRecord.findFirst({ where: { runId: 'run_orphan_1' } })
    expect(orphan!.status).toBe('failed')
    expect(orphan!.stopReason).toBe('crashed')
    expect(orphan!.completedAt).not.toBeNull()
    // (2) run sống trong bộ nhớ → KHÔNG bị đụng (LLM call dài không bị giết nhầm)
    const live = await db.agentRunRecord.findFirst({ where: { runId: 'run_live_1' } })
    expect(live!.status).toBe('running')
    // (3) run <30' → dưới ngưỡng → KHÔNG bị đụng
    const young = await db.agentRunRecord.findFirst({ where: { runId: 'run_young_1' } })
    expect(young!.status).toBe('running')
    // (4) obs.alert rule orphan-sweep phát ĐÚNG payload + gắn kim tuyến runId
    const sweeps = (await alertPayloads()).filter(p => p.rule === 'orphan-sweep')
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0].targetId).toBe('run_orphan_1')
    expect(sweeps[0].runId).toBe('run_orphan_1')
    expect(sweeps[0].agentName).toBe('MEGATRON')
    expect(sweeps[0].orphanMinutes).toBe(40)
    expect(sweeps[0].thresholdMinutes).toBe(ALERT_ORPHAN_AFTER_MS / 60_000)
    expect(String(sweeps[0].action)).toContain('failed/crashed')
    expect(String(sweeps[0].protocol)).toContain('D1.2')
    const evt = await db.observationEvent.findFirst({ where: { kind: 'obs.alert', runId: 'run_orphan_1' } })
    expect(evt).not.toBeNull() // sự kiện gắn đúng kim tuyến run

    // dọn registry — không rò state sang test sau (globalThis sống qua describe)
    endAgentRun('r99-obs-alerts', 'run_live_1', 'done')
    expect(isRunIdActiveInMemory('run_live_1')).toBe(false)
  })
})

// ==================== E. ensureDailyKpiSnapshots (GAP-1) ====================

describe('r99 · E — ensureDailyKpiSnapshots (cadence 2h + final hôm qua)', () => {
  test('E1 lần đầu — compute đủ hôm nay + hôm qua (KPI_REGISTRY.length dòng mỗi ngày)', async () => {
    resetKpiEnsureGuard()
    await db.kpiSnapshot.deleteMany({})
    expect(KPI_REGISTRY.length).toBeGreaterThan(0) // pin registry còn định nghĩa
    const t1 = Date.now()
    await ensureDailyKpiSnapshots(t1)
    const dToday = kpiDateOf(new Date(t1))
    const dYest = kpiDateOf(new Date(t1 - 24 * 3600_000))
    expect(await db.kpiSnapshot.count({ where: { date: dToday } })).toBe(KPI_REGISTRY.length)
    expect(await db.kpiSnapshot.count({ where: { date: dYest } })).toBe(KPI_REGISTRY.length) // final hôm qua
  })

  test('E2 guard 2 GIỜ — giữa 2 cửa KHÔNG compute lại (tick chỉ tốn count)', async () => {
    expect(KPI_ENSURE_EVERY_MS).toBe(2 * 3600_000)
    const t2 = Date.now() + 30 * MIN // trong cửa 2h kể từ E1
    const dToday = kpiDateOf(new Date(t2))
    await db.kpiSnapshot.deleteMany({ where: { date: dToday } }) // hôm nay thiếu → phải qua guard
    await ensureDailyKpiSnapshots(t2)
    // guard chặn — KHÔNG compute lại (nếu không có guard sẽ thấy đủ dòng lại)
    expect(await db.kpiSnapshot.count({ where: { date: dToday } })).toBe(0)
  })

  test('E3 hết 2h → làm mới hôm nay (upsert idempotent theo @@unique [date,kpi])', async () => {
    const t3 = Date.now() + KPI_ENSURE_EVERY_MS + MIN
    const dToday = kpiDateOf(new Date(t3))
    await ensureDailyKpiSnapshots(t3)
    expect(await db.kpiSnapshot.count({ where: { date: dToday } })).toBe(KPI_REGISTRY.length)
  })

  test('E4 hôm qua ĐÃ ĐỦ → final 1 lần KHÔNG đè số cuối (sentinel giữ nguyên)', async () => {
    const t4 = Date.now() + 2 * KPI_ENSURE_EVERY_MS + 2 * MIN
    const dToday = kpiDateOf(new Date(t4))
    const dYest = kpiDateOf(new Date(t4 - 24 * 3600_000))
    // hôm qua đã đủ (E1) — cắm sentinel vào 1 dòng để chứng minh không bị đè
    const sentinelKey = KPI_REGISTRY[0].key
    await db.kpiSnapshot.update({
      where: { date_kpi: { date: dYest, kpi: sentinelKey } },
      data: { value: 999.5 },
    })
    // ép đi qua nhánh compute: hôm nay thiếu 1 dòng (light-check không early-return)
    await db.kpiSnapshot.deleteMany({
      where: { date: dToday, kpi: KPI_REGISTRY[KPI_REGISTRY.length - 1].key },
    })
    resetKpiEnsureGuard() // buộc cửa 2h mở — kiểm tra riêng nhánh "hôm qua đủ"
    await ensureDailyKpiSnapshots(t4)
    // hôm nay được LÀM MỚI trọn vẹn...
    expect(await db.kpiSnapshot.count({ where: { date: dToday } })).toBe(KPI_REGISTRY.length)
    // ...nhưng hôm qua KHÔNG đụng — sentinel nguyên vẹn (final chỉ 1 lần)
    const y = await db.kpiSnapshot.findUnique({
      where: { date_kpi: { date: dYest, kpi: sentinelKey } },
    })
    expect(y?.value).toBe(999.5)
  })
})

// ==================== F. GET /api/observation/timeline — ?brain= + alerts24h ====================

describe('r99 · F — timeline ?brain= (traces theo cột + events theo payload) + alerts24h', () => {
  beforeAll(async () => {
    await db.observationEvent.deleteMany({})
    await db.brainInferenceTrace.deleteMany({})
    // payload RÁCH trực tiếp DB (seq 1 — ledger sẽ cấp MAX+1 từ 2 trở đi)
    await db.observationEvent.create({
      data: {
        seq: 1, actor: 'system', kind: 'qentry.add', summary: 'payload rách',
        payloadJson: '{"brain": "surrog', ts: new Date(Date.now() - 60_000),
      },
    })
    // 4 sự kiện payload.brain=surrogate (1 cái runId khác để pin AND) +
    // 1 policy + 1 không có brain — qua ledger (OBS_LEDGER on từ D6 restore)
    observeEventLedger({ actor: 'system', kind: 'run.start', runId: 'run_f1', summary: 'f surrogate 1', payload: { brain: 'surrogate' } })
    observeEventLedger({ actor: 'system', kind: 'run.start', runId: 'run_f2', summary: 'f policy', payload: { brain: 'policy' } })
    observeEventLedger({ actor: 'system', kind: 'db.write', summary: 'f không brain', payload: { note: 'không có brain' } })
    observeEventLedger({ actor: 'system', kind: 'run.start', runId: 'run_f1', summary: 'f surrogate 2', payload: { brain: 'surrogate' } })
    observeEventLedger({ actor: 'system', kind: 'run.start', runId: 'run_f1b', summary: 'f surrogate 3 (run khác)', payload: { brain: 'surrogate' } })
    observeEventLedger({ actor: 'system', kind: 'run.start', runId: 'run_f1', summary: 'f surrogate 4', payload: { brain: 'surrogate' } })
    await flushObservationQueue()
    // 3 trace: 2 surrogate (run_f1 + run_f1b) + 1 policy (run_f2)
    const mkTrace = (brain: string, runId: string, tag: string) =>
      db.brainInferenceTrace.create({
        data: {
          brain, organ: 'replay_eval', modelVersion: 1,
          inputHash: tag.padEnd(64, '0'), inputJson: null, outputJson: null,
          latencyMs: 1, runId,
        },
      })
    await mkTrace('surrogate', 'run_f1', 'surA')
    await mkTrace('surrogate', 'run_f1b', 'surB')
    await mkTrace('policy', 'run_f2', 'polA')
    // 3 sự kiện obs.alert: 2 trong 24h (now−1h, now−23h) + 1 ngoài (now−25h)
    const mx = (await db.observationEvent.findFirst({ orderBy: { seq: 'desc' } }))?.seq ?? 0
    await db.observationEvent.create({
      data: { seq: mx + 1, actor: 'system:alerts', kind: 'obs.alert', summary: 'a1', payloadJson: '{"rule":"test"}', ts: new Date(Date.now() - 1 * 3600_000) },
    })
    await db.observationEvent.create({
      data: { seq: mx + 2, actor: 'system:alerts', kind: 'obs.alert', summary: 'a2', payloadJson: '{"rule":"test"}', ts: new Date(Date.now() - 23 * 3600_000) },
    })
    await db.observationEvent.create({
      data: { seq: mx + 3, actor: 'system:alerts', kind: 'obs.alert', summary: 'a3 cũ', payloadJson: '{"rule":"test"}', ts: new Date(Date.now() - 25 * 3600_000) },
    })
  })

  test('F1 ?brain=surrogate — events CHỈ payload.brain khớp (rách/khác/không-brain loại); traces theo CỘT brain', async () => {
    const res = await callTimeline('?brain=surrogate')
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      events: Array<{ seq: number; kind: string; runId: string | null; summary: string; payload: Record<string, unknown> }>
      hasMore: boolean
      total: number
      traces: Array<{ brain: string; runId: string | null }>
      alerts24h: number
    }
    expect(json.ok).toBe(true)
    // 4 sự kiện surrogate (f1..f4) — payload rách + policy + không-brain + 3 obs.alert đều loại
    expect(json.events).toHaveLength(4)
    expect(json.events.every(e => e.payload.brain === 'surrogate')).toBe(true)
    expect(json.events.some(e => e.summary === 'payload rách')).toBe(false)
    // newest-first giữ nguyên trên trang ĐÃ LỌC
    for (let i = 1; i < json.events.length; i++) {
      expect(json.events[i].seq).toBeLessThan(json.events[i - 1].seq)
    }
    // traces theo CỘT brain thật — 2 dòng surrogate
    expect(json.traces).toHaveLength(2)
    expect(json.traces.every(t => t.brain === 'surrogate')).toBe(true)
    // total TRUNG THỰC tầng DB (1 rách + 6 ledger + 3 alert = 10) — KHÔNG
    // tính payload.brain (JSDoc route: dùng events.length/hasMore để lật trang)
    expect(json.total).toBe(10)
    expect(json.hasMore).toBe(false)
    // alerts24h = 2 (obs.alert trong 24h — a1 + a2; a3 25h cũ loại)
    expect(json.alerts24h).toBe(2)
  })

  test('F2 paginate trên trang ĐÃ LỌC — hasMore/nextBefore đúng con trỏ filtered', async () => {
    const all = (await (await callTimeline('?brain=surrogate')).json()) as { events: Array<{ seq: number }> }
    const seqs = all.events.map(e => e.seq).sort((a, b) => b - a) // desc
    const p1 = (await (await callTimeline('?brain=surrogate&limit=2')).json()) as {
      events: Array<{ seq: number }>; hasMore: boolean; nextBefore: number | null
    }
    expect(p1.events.map(e => e.seq)).toEqual(seqs.slice(0, 2))
    expect(p1.hasMore).toBe(true)
    expect(p1.nextBefore).toBe(seqs[1])
    const p2 = (await (await callTimeline(`?brain=surrogate&limit=2&before=${seqs[1]}`)).json()) as {
      events: Array<{ seq: number }>; hasMore: boolean; nextBefore: number | null
    }
    expect(p2.events.map(e => e.seq)).toEqual(seqs.slice(2, 4))
    expect(p2.hasMore).toBe(false) // hết — đúng 2 còn lại
    expect(p2.nextBefore).toBeNull()
    // trang 3 rỗng (cursor hết dữ liệu khớp)
    const p3 = (await (await callTimeline(`?brain=surrogate&limit=2&before=${seqs[3]}`)).json()) as { events: unknown[] }
    expect(p3.events).toHaveLength(0)
  })

  test('F3 runId + brain AND cả hai — events theo 2 điều kiện, traces đúng cặp', async () => {
    const json = (await (await callTimeline('?runId=run_f1&brain=surrogate')).json()) as {
      events: Array<{ runId: string | null }>
      traces: Array<{ brain: string; runId: string | null }>
    }
    // 3 sự kiện surrogate của run_f1 (f1/f2/f4 — f3 thuộc run_f1b)
    expect(json.events).toHaveLength(3)
    expect(json.events.every(e => e.runId === 'run_f1')).toBe(true)
    // trace AND: chỉ dòng surrogate run_f1
    expect(json.traces).toHaveLength(1)
    expect(json.traces[0].brain).toBe('surrogate')
    expect(json.traces[0].runId).toBe('run_f1')
  })

  test('F4 brain lạ → 200 rỗng fail-open (KHÔNG 400) — alerts24h vẫn trả', async () => {
    const res = await callTimeline('?brain=khong_co_nao_nay')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; events: unknown[]; traces: unknown[]; alerts24h: number }
    expect(json.ok).toBe(true)
    expect(json.events).toEqual([])
    expect(json.traces).toEqual([])
    expect(json.alerts24h).toBe(2) // tổng quan — không phụ thuộc filter brain
  })

  test('F5 không brain → nhánh cũ nguyên vẹn (mọi event) + alerts24h không đổi', async () => {
    const json = (await (await callTimeline('')).json()) as { events: unknown[]; alerts24h: number; traces: unknown[] }
    // 1 rách + 6 ledger (parse rách vẫn hiện payload unparseable) + 3 alert = 10
    expect(json.events).toHaveLength(10)
    expect(json.traces).toEqual([]) // traces CHỈ join khi có runId/brain (C.4 giữ nguyên)
    expect(json.alerts24h).toBe(2)
  })
})

// helper riêng F — observeEvent import đặt tên tránh trùng flush
import { observeEvent as observeEventLedger } from '@/lib/observation/ledger'

// ==================== G. GET /api/brain/activity — training bus + backprop ====================

describe('r99 · G — activity: training từ bus (MỌI brain) + backprop trung thực', () => {
  beforeAll(async () => {
    // dọn nguồn route: dormant mọi brain trừ policy seed ở G3; bus sạch
    await db.agentRunRecord.deleteMany({})
    await db.brainModel.deleteMany({
      where: { brain: { in: ['calibration_v3', 'surrogate', 'policy'] } },
    })
    trainProgressReset()
  })

  test('G1 bus trống + dormant → training null + backprop null (không active model)', async () => {
    const json = await activity('policy')
    expect(json.ok).toBe(true)
    expect(json.status).toBe('dormant')
    expect(json.training).toBeNull()
    expect(json.backprop).toBeNull() // dormant: inputVector chưa chuẩn hóa → không tính
  })

  test('G2 training = snapshot bus — route KHÔNG lọc theo brain (FE tự so khớp)', async () => {
    trainProgressStart('calibration_v3', null) // train brain KHÁC brain đang xem
    const running = await activity('policy')
    expect(running.training).not.toBeNull()
    expect(running.training!.brain).toBe('calibration_v3')
    expect(running.training!.status).toBe('running')
    expect(running.training!.endedAt).toBeNull()
    expect(Number.isNaN(Date.parse(running.training!.startedAt))).toBe(false)
    trainProgressEnd('calibration_v3', false, undefined, 'test G2 fail')
    const failed = await activity('surrogate')
    expect(failed.training!.status).toBe('failed')
    expect(failed.training!.brain).toBe('calibration_v3')
    trainProgressReset() // dọn — không rò sang file test khác
  })

  test('G3 policy ACTIVE → backprop trung thực null-số + label giải thích (KHÔNG nhãn thật cho 1 run)', async () => {
    // seed 1 run hoàn thành + bản policy active đủ điều kiện loadActivePolicy
    await db.agentRunRecord.create({
      data: {
        sessionId: 'r99-g3', runId: 'run_g3', agentName: 'tester', model: 'gpt-x',
        status: 'completed', complete: true, tokensUsed: 100, durationMs: 900,
        createdAt: new Date(Date.now() - 5 * MIN),
      },
    })
    const vocab = { agents: ['tester'] }
    const actionVocab = { models: ['alpha', 'beta'] }
    const d = policyFeatureNames(vocab).length // 2 (agent + delegated)
    const mlp = new MLP({
      layers: [
        { units: d, activation: 'linear' },
        { units: 4, activation: 'tanh' },
        { units: actionVocab.models.length, activation: 'softmax' },
      ],
      loss: 'crossEntropy', optimizer: 'adam', lr: 0.01, l2: 0.01, seed: 77,
    })
    await db.brainModel.create({
      data: {
        brain: 'policy', version: 9901, inputMode: 'task-features',
        specJson: JSON.stringify({ vocab, actionVocab }),
        weightsJson: JSON.stringify({ mlp: mlp.serialize() }),
        trainMetaJson: JSON.stringify({
          nSamples: 25, successRate: 0.5,
          standardization: { means: [0, 0], stds: [1, 1] },
          cvScore: 0.5, brierBaseline: 0.6,
        }),
        active: true,
      },
    })

    const json = await activity('policy')
    expect(json.status).toBe('active')
    // TRUNG THỰC: policy không có nhãn thật cho 1 run riêng lẻ (y là phân phối
    // mixture chỉ build từ reward ledger lúc train) → null-số + label giải thích
    expect(json.backprop).not.toBeNull()
    expect(json.backprop!.deltas).toBeNull()
    expect(json.backprop!.yTrue).toBeNull()
    expect(json.backprop!.loss).toBeNull()
    expect(json.backprop!.label).toContain('chưa có nhãn thật')
    expect(json.backprop!.label).toContain('policy')
  })
})
