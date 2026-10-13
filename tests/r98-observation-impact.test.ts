/**
 * ROUND-98 TESTS — OBS-P4 · IMPACT TRACKER + META-HEALTH
 * (BLUEPRINT-OBSERVATION-P1-P4 §C.6 — chốt §7 Q5 Task 23 2026-10-13)
 *
 * Đo lường:
 *   A. estimateKpiImpact PURE (pin bảng tay): rate KPI (KPI_REGISTRY rate:true,
 *      value ∈[0,1], n>0) → delta + CI 95% thô z·√(se²B+se²A); non-rate /
 *      n=0 → CI null. Công thức tay: before p=0.4 n=100, after p=0.5 n=100 →
 *      seB=√(0.4·0.6/100)=0.049, seA=√(0.5·0.5/100)=0.05 →
 *      half=1.96·√(0.0024+0.0025)=1.96·0.07=0.1372 → CI=[−0.0372, 0.2372].
 *      A4: KPI trung bình (eval_ndcg) + KPI lạ → CI null (FB-OBS-R1-04).
 *   B. formatImpactDelta: dấu phẩy vi-VN + dấu +.
 *   C. computeImpactEstimates (DB cô lập): TuningChangeLog 25h trước +
 *      KpiSnapshot ngày-trước (0.4/n100) + ngày-sau (0.5/n100) → 1 sự kiện
 *      impact.estimate (payload changeLogId + kpis + window.note correlation
 *      KHÔNG nhân quả — RO-6) — chạy lần 2 → 0 (dedup).
 *   D. Cửa sổ snapshot ngày (Q5 §7 chốt): change CÙNG NGÀY snapshot sau →
 *      KHÔNG tính (trộn trước/sau); thiếu 1 bên → bỏ qua. C4: cùng ngày nhưng
 *      có snapshot NGÀY KẾ → dùng ngày kế (FB-OBS-R1-02). C5/C6: ngoài ±3 ngày
 *      mỗi bên → bỏ (FB-OBS-R1-01 — OBS_IMPACT_LOOK_DAYS sống lại).
 *   E. Batch cap OBS_IMPACT_BATCH=20: 25 change đủ điều kiện → tick 1 ghi 20,
 *      tick 2 ghi nốt 5.
 *   F. emitObservationHealth: 1 sự kiện obs.health với counters ledger+trace.
 *   G. Worker singleton: start ×2 không throw + globalThis guard; stop dọn
 *      sạch (timer null, started false); cờ off → tick no-op. G4: obs_ledger
 *      off → computeImpactEstimates 0 không đếm giả (FB-OBS-R1-11).
 *
 * DB CÔ LẬP qua preload — cleanup afterAll pattern r92.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  estimateKpiImpact, formatImpactDelta, computeImpactEstimates, emitObservationHealth,
  startObservationImpactWorker, stopObservationImpactWorker, isObsImpactEnabled,
  OBS_IMPACT_BATCH, OBS_IMPACT_MIN_AGE_MS, kpiDateOf,
} from '@/lib/observation/impact'
import { flushObservationQueue, isObsLedgerEnabled } from '@/lib/observation/ledger'
import { resetTuningValue, refreshTuningSnapshot } from '@/lib/learning/tuning-store'

const DAY = 24 * 3600 * 1000
const H25 = 25 * 3600 * 1000

async function seedChange(key: string, ageMs: number): Promise<number> {
  const row = await db.tuningChangeLog.create({
    data: {
      key,
      action: 'set',
      fromStoreValue: null,
      toStoreValue: '0.2',
      fromEffectiveValue: '0.1',
      toEffectiveValue: '0.2',
      createdAt: new Date(Date.now() - ageMs),
    },
  })
  return row.id
}

async function seedKpi(kpi: string, date: string, value: number, sampleSize: number): Promise<void> {
  await db.kpiSnapshot.upsert({
    where: { date_kpi: { date, kpi } },
    create: { date, kpi, value, sampleSize },
    update: { value, sampleSize },
  })
}

async function impactEvents(): Promise<Array<{ payloadJson: string }>> {
  return db.observationEvent.findMany({ where: { kind: 'impact.estimate' } })
}

beforeAll(async () => {
  process.env.OBS_LEDGER = 'on'
  delete process.env.OBS_IMPACT
  delete process.env.OBS_BRAIN_TRACE
  delete process.env.UI_OBSERVATION
  await db.tuningParam.deleteMany({
    where: { key: { in: ['obs_ledger', 'obs_brain_trace', 'obs_impact', 'ui_observation'] } },
  })
  await refreshTuningSnapshot()
  await db.observationEvent.deleteMany({})
  await db.tuningChangeLog.deleteMany({})
  await db.kpiSnapshot.deleteMany({})
})

afterAll(async () => {
  stopObservationImpactWorker()
  delete process.env.OBS_LEDGER
  delete process.env.OBS_IMPACT
  delete process.env.OBS_BRAIN_TRACE
  delete process.env.UI_OBSERVATION
  for (const k of ['obs_ledger', 'obs_brain_trace', 'obs_impact', 'ui_observation']) {
    try { await resetTuningValue(k) } catch { /* chưa set — bỏ */ }
  }
  await refreshTuningSnapshot()
  await db.observationEvent.deleteMany({})
  await db.tuningChangeLog.deleteMany({})
  await db.kpiSnapshot.deleteMany({})
})

// ==================== A. estimateKpiImpact — PURE pin bảng tay ====================

describe('r98 · A — estimateKpiImpact pure (CI thô rate KPI)', () => {
  test('A1 rate KPI: delta + CI đúng công thức tay (±0.0001)', () => {
    const r = estimateKpiImpact(
      'mission_success_rate',
      { date: '2026-10-10', value: 0.4, sampleSize: 100 },
      { date: '2026-10-12', value: 0.5, sampleSize: 100 },
      'higher',
    )
    expect(r.delta).toBeCloseTo(0.1, 10)
    expect(r.ciLow).toBeCloseTo(0.1 - 1.96 * Math.sqrt(0.0024 + 0.0025), 4)
    expect(r.ciHigh).toBeCloseTo(0.1 + 1.96 * Math.sqrt(0.0024 + 0.0025), 4)
    expect(r.ciLow).not.toBeNull()
    expect(r.direction).toBe('higher')
  })

  test('A2 non-rate KPI (value ngoài [0,1]) → CI null, delta vẫn có', () => {
    const r = estimateKpiImpact(
      'anomaly_count_24h',
      { date: '2026-10-10', value: 12, sampleSize: 50 },
      { date: '2026-10-12', value: 9, sampleSize: 50 },
      'lower',
    )
    expect(r.delta).toBe(-3)
    expect(r.ciLow).toBeNull()
    expect(r.ciHigh).toBeNull()
  })

  test('A3 n=0 → không chia 0 (CI null)', () => {
    const r = estimateKpiImpact(
      'eval_ndcg',
      { date: '2026-10-10', value: 0.5, sampleSize: 0 },
      { date: '2026-10-12', value: 0.6, sampleSize: 10 },
    )
    expect(r.ciLow).toBeNull()
  })

  test('A4 KPI trung bình nằm [0,1] → CI null (FB-OBS-R1-04 — bỏ heuristic value∈[0,1])', () => {
    // eval_ndcg là TRUNG BÌNH nDCG per-case ∈[0,1] — heuristic cũ (value∈[0,1]
    // ∧ n>0) gán CI binomial sai mô hình phương sai; sau fix rate lấy từ
    // KPI_REGISTRY (đánh dấu rate:true) — trung bình/đếm → null trung thực
    const r = estimateKpiImpact(
      'eval_ndcg',
      { date: '2026-10-10', value: 0.626, sampleSize: 3 },
      { date: '2026-10-12', value: 0.667, sampleSize: 4 },
      'higher',
    )
    expect(r.delta).toBeCloseTo(0.041, 10)
    expect(r.ciLow).toBeNull() // heuristic cũ trả CI khác null — lỗi cũ hết sau fix
    expect(r.ciHigh).toBeNull()
    // KPI lạ ngoài registry → null (bảo thủ — không đoán rate)
    const r2 = estimateKpiImpact(
      'kpi_khong_co_trong_registry',
      { date: '2026-10-10', value: 0.4, sampleSize: 100 },
      { date: '2026-10-12', value: 0.5, sampleSize: 100 },
    )
    expect(r2.ciLow).toBeNull()
    expect(r2.ciHigh).toBeNull()
    // chấm chéo: rate:true thật (mission_success_rate) vẫn có CI — A1 dùng cùng key
    const r3 = estimateKpiImpact(
      'mission_success_rate',
      { date: '2026-10-10', value: 0.4, sampleSize: 100 },
      { date: '2026-10-12', value: 0.5, sampleSize: 100 },
    )
    expect(r3.ciLow).not.toBeNull()
    expect(r3.ciHigh).not.toBeNull()
  })
})

// ==================== B. formatImpactDelta ====================

describe('r98 · B — formatImpactDelta (dấu phẩy vi-VN)', () => {
  test('B1 dương +0,1234 · âm -0,0500', () => {
    expect(formatImpactDelta(0.1234)).toBe('+0,1234')
    expect(formatImpactDelta(-0.05)).toBe('-0,0500')
    expect(formatImpactDelta(0)).toBe('+0,0000')
  })

  test('B2 kpiDateOf YYYY-MM-DD UTC', () => {
    expect(kpiDateOf(new Date('2026-10-13T23:59:59Z'))).toBe('2026-10-13')
  })
})

// ==================== C. computeImpactEstimates — integration ====================

describe('r98 · C — computeImpactEstimates (Q5 §7: snapshot ngày liền trước/sau)', () => {
  test('C1 change 25h + 2 snapshot → 1 event đúng payload; lần 2 → 0 (dedup)', async () => {
    await db.observationEvent.deleteMany({ where: { kind: 'impact.estimate' } })
    const changeDay = kpiDateOf(new Date(Date.now() - H25))
    const before = kpiDateOf(new Date(Date.now() - H25 - DAY))
    const after = kpiDateOf(new Date(Date.now() - H25 + DAY))
    const changeId = await seedChange('q_learning_alpha', H25)
    await seedKpi('mission_success_rate', before, 0.4, 100)
    await seedKpi('mission_success_rate', after, 0.5, 100)

    const n1 = await computeImpactEstimates()
    expect(n1).toBe(1)
    await flushObservationQueue()
    const events = await impactEvents()
    expect(events.length).toBe(1)
    const p = JSON.parse(events[0].payloadJson) as {
      changeLogId: number
      key: string
      kpis: Array<{ kpi: string; delta: number; before: number; after: number }>
      window: { granularity: string; note: string }
    }
    expect(p.changeLogId).toBe(changeId)
    expect(p.key).toBe('q_learning_alpha')
    expect(p.kpis.length).toBe(1)
    expect(p.kpis[0].kpi).toBe('mission_success_rate')
    expect(p.kpis[0].before).toBe(0.4)
    expect(p.kpis[0].after).toBe(0.5)
    expect(p.kpis[0].delta).toBeCloseTo(0.1, 10)
    // RO-6 — framing trung thực bắt buộc
    expect(p.window.granularity).toBe('daily-snapshot')
    expect(p.window.note).toContain('KHÔNG')
    expect(p.window.note).toContain('nhân quả')

    // Dedup — chạy lại không ghi thêm
    const n2 = await computeImpactEstimates()
    expect(n2).toBe(0)
    await flushObservationQueue()
    expect((await impactEvents()).length).toBe(1)
  })

  test('C2 change NHẸ hơn 24h → chưa chấm (đợi snapshot ngày sau)', async () => {
    // isolate HOÀN TOÀN case này: bỏ change + KPI + dedup-marker của case trước
    // (bài học vòng 1: KPI mission_success_rate của C1 rò vào cửa sổ change
    // khác → ước lượng chéo — mỗi case tự chủ về dữ liệu)
    await db.observationEvent.deleteMany({ where: { kind: 'impact.estimate' } })
    await db.tuningChangeLog.deleteMany({})
    await db.kpiSnapshot.deleteMany({})
    await seedKpi('mission_success_rate', kpiDateOf(new Date(Date.now() - 2 * DAY)), 0.4, 100)
    await seedKpi('mission_success_rate', kpiDateOf(new Date()), 0.5, 100)
    await seedChange('q_learning_gamma', 3600_000) // 1h trước — chưa đủ tuổi
    const n = await computeImpactEstimates()
    expect(n).toBe(0)
  })

  test('C3 snapshot SAU trùng ngày change → bỏ (trộn trước/sau); thiếu trước → bỏ', async () => {
    // isolate đầy đủ (bài học vòng 1 — xem C2)
    await db.observationEvent.deleteMany({ where: { kind: 'impact.estimate' } })
    await db.tuningChangeLog.deleteMany({})
    await db.kpiSnapshot.deleteMany({})
    const changeDay = kpiDateOf(new Date(Date.now() - H25))
    // snapshot "sau" nằm NGAY ngày change (không phải ngày liền sau) → bỏ
    await seedChange('runtime_model_tau', H25)
    await seedKpi('verdict_precision', kpiDateOf(new Date(Date.now() - H25 - DAY)), 0.5, 50)
    await seedKpi('verdict_precision', changeDay, 0.55, 50)
    expect(await computeImpactEstimates()).toBe(0)
  })

  test('C4 cùng ngày change CÓ snapshot ngày kế → dùng ngày kế (FB-OBS-R1-02)', async () => {
    // isolate đầy đủ (bài học vòng 1 — xem C2)
    await db.observationEvent.deleteMany({ where: { kind: 'impact.estimate' } })
    await db.tuningChangeLog.deleteMany({})
    await db.kpiSnapshot.deleteMany({})
    const changeDay = kpiDateOf(new Date(Date.now() - H25))
    // before −1d · trùng ngày changeDay (bỏ, dữ liệu trộn) · NGÀY KẾ +1d
    // — code cũ chặn cả KPI (0 event); code fix bỏ snapshot trùng, lấy +1d
    await seedChange('verdict_precision_case', H25)
    await seedKpi('verdict_precision', kpiDateOf(new Date(Date.now() - H25 - DAY)), 0.5, 50)
    await seedKpi('verdict_precision', changeDay, 0.55, 50) // cùng ngày — bị bỏ qua
    await seedKpi('verdict_precision', kpiDateOf(new Date(Date.now() - H25 + DAY)), 0.6, 50)
    expect(await computeImpactEstimates()).toBe(1)
    await flushObservationQueue()
    const events = await impactEvents()
    expect(events.length).toBe(1)
    const p = JSON.parse(events[0].payloadJson) as {
      kpis: Array<{ kpi: string; before: number; after: number; delta: number }>
      window: { lookDays: number }
    }
    expect(p.kpis.length).toBe(1)
    expect(p.kpis[0].before).toBe(0.5) // −1d
    expect(p.kpis[0].after).toBe(0.6) // +1d — KHÔNG dùng 0.55 của ngày trùng
    expect(p.kpis[0].delta).toBeCloseTo(0.1, 10)
    expect(p.window.lookDays).toBe(3) // pin hằng số sống lại (FB-OBS-R1-01)
  })

  test('C5 before NGOÀI ±3 ngày (cách 10 ngày) → bỏ KPI (FB-OBS-R1-01)', async () => {
    // isolate đầy đủ (bài học vòng 1 — xem C2)
    await db.observationEvent.deleteMany({ where: { kind: 'impact.estimate' } })
    await db.tuningChangeLog.deleteMany({})
    await db.kpiSnapshot.deleteMany({})
    await seedChange('tool_success_rate_case', H25)
    // before cách change 10 NGÀY (ngoài ±3) — code cũ vẫn chấm với snapshot 10 ngày trước
    await seedKpi('tool_success_rate', kpiDateOf(new Date(Date.now() - H25 - 10 * DAY)), 0.4, 100)
    await seedKpi('tool_success_rate', kpiDateOf(new Date(Date.now() - H25 + DAY)), 0.5, 100)
    expect(await computeImpactEstimates()).toBe(0)
  })

  test('C6 after NGOÀI ±3 ngày (cách 5 ngày) → bỏ KPI (FB-OBS-R1-01)', async () => {
    await db.observationEvent.deleteMany({ where: { kind: 'impact.estimate' } })
    await db.tuningChangeLog.deleteMany({})
    await db.kpiSnapshot.deleteMany({})
    await seedChange('kb_fallback_case', H25)
    // before −2d (trong cửa sổ) nhưng after +5d (ngoài ±3) — code cũ vẫn chấm
    await seedKpi('kb_fallback_rate', kpiDateOf(new Date(Date.now() - H25 - 2 * DAY)), 0.3, 40)
    await seedKpi('kb_fallback_rate', kpiDateOf(new Date(Date.now() - H25 + 5 * DAY)), 0.2, 40)
    expect(await computeImpactEstimates()).toBe(0)
  })
})

// ==================== E. Batch cap ====================

describe('r98 · E — batch cap OBS_IMPACT_BATCH=20/tick', () => {
  test('E1 25 change đủ điều kiện → tick 1 ghi 20 · tick 2 ghi 5', async () => {
    await db.observationEvent.deleteMany({ where: { kind: 'impact.estimate' } })
    await db.tuningChangeLog.deleteMany({})
    const changeDay = kpiDateOf(new Date(Date.now() - H25))
    await seedKpi('tool_success_rate', kpiDateOf(new Date(Date.now() - H25 - DAY)), 0.8, 200)
    await seedKpi('tool_success_rate', kpiDateOf(new Date(Date.now() - H25 + DAY)), 0.82, 200)
    for (let i = 0; i < 25; i++) {
      await seedChange(`batch_key_${i}`, H25 + i * 1000)
    }
    void changeDay
    const n1 = await computeImpactEstimates()
    expect(n1).toBe(20) // cap
    await flushObservationQueue()
    expect((await impactEvents()).length).toBe(20)
    const n2 = await computeImpactEstimates()
    expect(n2).toBe(5) // phần dư
    await flushObservationQueue()
    expect((await impactEvents()).length).toBe(25)
    expect(OBS_IMPACT_BATCH).toBe(20) // pin hằng số (doctrine #1)
  })
})

// ==================== F. obs.health (meta-health GAP-7) ====================

describe('r98 · F — emitObservationHealth', () => {
  test('F1 1 sự kiện obs.health với counters ledger + trace + healthy flag', async () => {
    await db.observationEvent.deleteMany({ where: { kind: 'obs.health' } })
    await emitObservationHealth()
    await flushObservationQueue()
    const events = await db.observationEvent.findMany({ where: { kind: 'obs.health' } })
    expect(events.length).toBe(1)
    const p = JSON.parse(events[0].payloadJson) as {
      ledger: { written: number; dropped: number }
      trace: { written: number; dropped: number }
      healthy: boolean
    }
    expect(typeof p.ledger.written).toBe('number')
    expect(typeof p.trace.dropped).toBe('number')
    expect(typeof p.healthy).toBe('boolean')
  })
})

// ==================== G. Worker singleton + cờ ====================

describe('r98 · G — worker singleton (tick precedent GoalLoopWorker)', () => {
  test('G1 start ×2 không throw (globalThis guard) + stop dọn sạch', () => {
    expect(() => {
      startObservationImpactWorker()
      startObservationImpactWorker() // lần 2 bị guard — không double interval
    }).not.toThrow()
    stopObservationImpactWorker()
  })

  test('G2 cờ obs_impact off mặc định (ENV unset) → isObsImpactEnabled false', () => {
    expect(isObsImpactEnabled()).toBe(false)
    expect(OBS_IMPACT_MIN_AGE_MS).toBe(24 * 3600 * 1000) // pin §C.6
  })

  test('G3 cờ on → isObsImpactEnabled true (hiệu lực ngay không restart)', () => {
    process.env.OBS_IMPACT = 'on'
    expect(isObsImpactEnabled()).toBe(true)
    delete process.env.OBS_IMPACT
    expect(isObsImpactEnabled()).toBe(false)
  })

  test('G4 obs_ledger off (dù obs_impact on) → computeImpactEstimates 0, không đếm giả (FB-OBS-R1-11)', async () => {
    // dữ kiện ĐỦ điều kiện (change 25h + snapshot ±1d) nhưng obs_ledger off:
    // code cũ vẫn quét + written++ đếm sự kiện KHÔNG được ghi + dedup không
    // bao giờ nhúng → rescan vĩnh viễn mỗi tick; code fix guard đầu → 0
    await db.observationEvent.deleteMany({ where: { kind: 'impact.estimate' } })
    await db.tuningChangeLog.deleteMany({})
    await db.kpiSnapshot.deleteMany({})
    await seedChange('q_learning_beta', H25)
    await seedKpi('mission_success_rate', kpiDateOf(new Date(Date.now() - H25 - DAY)), 0.4, 100)
    await seedKpi('mission_success_rate', kpiDateOf(new Date(Date.now() - H25 + DAY)), 0.5, 100)
    delete process.env.OBS_LEDGER
    process.env.OBS_IMPACT = 'on' // obs_impact on nhưng obs_ledger off
    await refreshTuningSnapshot()
    try {
      expect(isObsLedgerEnabled()).toBe(false) // pin trạng thái mô phỏng đúng
      expect(await computeImpactEstimates()).toBe(0) // code cũ trả 1 — lỗi cũ hết
      await flushObservationQueue()
      expect((await impactEvents()).length).toBe(0)
    } finally {
      process.env.OBS_LEDGER = 'on'
      delete process.env.OBS_IMPACT
      await refreshTuningSnapshot()
      await db.tuningChangeLog.deleteMany({})
      await db.kpiSnapshot.deleteMany({})
    }
  })
})
