/**
 * ROUND-76 TESTS — P1-M4 KPI LAYER (BLUEPRINT-STATS-LEARNING-P0-P6 §P1-M4,
 * mục #5 — DA.pdf §KPIs and Metrics)
 *
 * Đo lường: KPI_REGISTRY (10 KPI — 9 gốc + P3-M4 digest_gate_fallback_rate, single source) + computeAllKpis (upsert
 * KpiSnapshot hôm nay idempotent theo unique date+kpi, fail-open per KPI)
 * + statusForKpi (dải ±10%).
 *
 * Nguyên tắc test:
 * - DB-cô-lập (bunfig preload copy): WIPE toàn bộ bảng nguồn (AgentRunRecord,
 *   ArbiterVerdict, ToolMetric, MetricAnomaly, EvalRun, EvalResult,
 *   KpiSnapshot) — KPI phải deterministic theo seed, không dính dữ liệu
 *   production copy.
 * - Mọi expected DẪN NGUỒN ĐƯỢC (comment) — cùng kì vọng math với test M1.
 *
 * Seed:
 *   AgentRunRecord 24h: r1 completed · r2 completed (parentRunId='run_x') ·
 *     r3 failed · r4 cancelled → mission_success_rate = 2/4 = 0.5 (n=4);
 *     delegation_ratio = 1/4 = 0.25 (n=4)
 *   ArbiterVerdict: ma trận 6 verdict như r76-verdict-scorecard
 *     (tp2/fp1/fn1/tn2) → verdict_precision = verdict_f1 = 0.6667 (n=6)
 *   ToolMetric 24h: 4 success + 1 fail → tool_success_rate = 0.8 (n=5)
 *   MetricAnomaly 24h: 2 rows → anomaly_count_24h = 2 (n=2)
 *   EvalRun: 1 completed (avgNdcg=0.75, avgRecallAt5=0.8, caseCount=3,
 *     startedAt 1h trước) + 1 running MỚI HƠN → eval_ndcg=0.75 (n=3),
 *     eval_recall=0.8 (n=3) — run completed mới nhất thắng
 *   EvalResult: rawConfidence [0.6, 0.7, 0.3, 0.45] → kb_fallback_rate =
 *     2/4 = 0.5 (n=4) — ngưỡng CONFIDENCE_THRESHOLD = 0.5
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import { computeAllKpis, todayUtcDate } from '@/lib/kpi/compute'
import { KPI_REGISTRY, statusForKpi, type KpiDef } from '@/lib/kpi/registry'

const NOW = Date.now()

async function seedVerdict(
  agentName: string,
  cycle: number,
  complete: boolean,
  confidence: number,
  runComplete: boolean,
): Promise<void> {
  await db.arbiterVerdict.create({
    data: {
      sessionId: 'test-r76-kpi',
      agentName,
      cycle,
      complete,
      confidence,
      verified: true,
      outcome: complete === runComplete ? 'confirmed' : 'refuted',
      runComplete,
      runStopReason: runComplete ? 'complete' : 'max_cycles',
      createdAt: new Date(NOW - 60_000),
    },
  })
}

describe('r76 · P1-M4 KPI layer', () => {
  beforeAll(async () => {
    // WIPE mọi bảng nguồn trong bản copy cô lập — deterministic theo seed
    await db.kpiSnapshot.deleteMany({})
    await db.metricAnomaly.deleteMany({})
    await db.evalResult.deleteMany({})
    await db.evalRun.deleteMany({})
    await db.arbiterVerdict.deleteMany({})
    await db.toolMetric.deleteMany({})
    await db.agentRunRecord.deleteMany({})
    await db.digestGateEvent.deleteMany({}) // P3-M4 — digest_gate_fallback_rate deterministic theo seed

    // AgentRunRecord — 4 run 24h
    for (const [status, parentRunId] of [
      ['completed', null],
      ['completed', 'run_x'],
      ['failed', null],
      ['cancelled', null],
    ] as Array<[string, string | null]>) {
      await db.agentRunRecord.create({
        data: {
          sessionId: 'test-r76-kpi',
          status,
          parentRunId,
          createdAt: new Date(NOW - 30_000),
        },
      })
    }

    // ArbiterVerdict — ma trận 6 verdict (tp2/fp1/fn1/tn2)
    await seedVerdict('OMEGA', 1, true, 0.9, true) // TP
    await seedVerdict('OMEGA', 2, true, 0.85, true) // TP
    await seedVerdict('CATALYST', 1, true, 0.95, false) // FP
    await seedVerdict('SENTINEL', 1, false, 0.3, true) // FN
    await seedVerdict('SENTINEL', 2, false, 0.2, false) // TN
    await seedVerdict('SENTINEL', 3, false, 0.4, false) // TN

    // ToolMetric — 5 call (4 success)
    for (let i = 0; i < 5; i++) {
      await db.toolMetric.create({
        data: {
          toolName: 'r76_kpi_tool',
          sessionId: 'test-r76-kpi',
          agentRole: 'TEST',
          success: i < 4,
          exitCode: i < 4 ? 0 : 1,
          durationMs: 100 + i,
          errorTag: i < 4 ? null : 'Error: test',
          timestamp: new Date(NOW - 20_000),
        },
      })
    }

    // MetricAnomaly — 2 điểm trong 24h
    for (let i = 0; i < 2; i++) {
      await db.metricAnomaly.create({
        data: {
          kind: 'tool_duration_high',
          toolName: 'r76_kpi_tool',
          agentRole: 'TEST',
          value: 9000 + i,
          bound: 4750,
          score: 5,
          sessionId: null,
          observedAt: new Date(NOW - 10_000),
        },
      })
    }

    // EvalRun — completed cũ hơn 1h + running mới hơn (completed vẫn thắng)
    const completedRun = await db.evalRun.create({
      data: {
        status: 'completed',
        caseCount: 3,
        processedCount: 3,
        avgNdcg: 0.75,
        avgMrr: 0.6,
        avgRecallAt5: 0.8,
        startedAt: new Date(NOW - 3600_000),
        completedAt: new Date(NOW - 3000_000),
      },
    })
    await db.evalRun.create({
      data: { status: 'running', caseCount: 10, startedAt: new Date(NOW - 1000) },
    })

    // EvalResult — 4 rows rawConfidence [0.6, 0.7, 0.3, 0.45]
    for (const [i, rawConfidence] of [0.6, 0.7, 0.3, 0.45].entries()) {
      await db.evalResult.create({
        data: {
          runId: completedRun.id,
          caseId: `case-${i}`,
          answer: 'seed',
          rawConfidence,
          createdAt: new Date(NOW - 2900_000),
        },
      })
    }
  })

  test('registry: 11 KPI (9 gốc + P3-M4 digest + P5-M4 ingestion_expectation_fails), key duy nhất, label/goal hợp lệ', () => {
    expect(KPI_REGISTRY.length).toBe(11)
    const keys = new Set(KPI_REGISTRY.map((d) => d.key))
    expect(keys.size).toBe(11)
    for (const d of KPI_REGISTRY) {
      expect(d.label.length).toBeGreaterThan(0)
      expect(['higher', 'lower']).toContain(d.goal)
      expect(typeof d.compute).toBe('function')
    }
    // Các KPI blueprint cần đủ mặt
    for (const key of [
      'mission_success_rate', 'verdict_precision', 'verdict_f1', 'tool_success_rate',
      'anomaly_count_24h', 'eval_ndcg', 'eval_recall', 'kb_fallback_rate', 'delegation_ratio',
      'digest_gate_fallback_rate',
      'ingestion_expectation_fails', // P5-M4 — đợt 7
    ]) {
      expect(keys.has(key)).toBe(true)
    }
  })

  test('computeAllKpis: đủ 11 KPI ok, giá trị khớp seed tính tay', async () => {
    const results = await computeAllKpis()
    expect(results.length).toBe(11)
    const byKey = new Map(results.map((r) => [r.key, r]))

    for (const r of results) {
      expect(r.ok, `${r.key} phải ok (error: ${r.error})`).toBe(true)
      expect(Number.isFinite(r.value)).toBe(true)
    }

    // mission_success_rate = 2/4
    expect(byKey.get('mission_success_rate')!.value).toBe(0.5)
    expect(byKey.get('mission_success_rate')!.sampleSize).toBe(4)
    // verdict_precision = verdict_f1 = 2/3 (round4)
    expect(byKey.get('verdict_precision')!.value).toBe(0.6667)
    expect(byKey.get('verdict_f1')!.value).toBe(0.6667)
    expect(byKey.get('verdict_precision')!.sampleSize).toBe(6)
    // tool_success_rate = 4/5
    expect(byKey.get('tool_success_rate')!.value).toBe(0.8)
    expect(byKey.get('tool_success_rate')!.sampleSize).toBe(5)
    // anomaly_count_24h = 2
    expect(byKey.get('anomaly_count_24h')!.value).toBe(2)
    // eval_ndcg = 0.75, eval_recall = 0.8 (run completed mới nhất, n=3)
    expect(byKey.get('eval_ndcg')!.value).toBe(0.75)
    expect(byKey.get('eval_ndcg')!.sampleSize).toBe(3)
    expect(byKey.get('eval_recall')!.value).toBe(0.8)
    // kb_fallback_rate = 2/4 (rawConfidence 0.3 & 0.45 < 0.5)
    expect(byKey.get('kb_fallback_rate')!.value).toBe(0.5)
    expect(byKey.get('kb_fallback_rate')!.sampleSize).toBe(4)
    // delegation_ratio = 1/4 (r2 có parentRunId)
    expect(byKey.get('delegation_ratio')!.value).toBe(0.25)
    expect(byKey.get('delegation_ratio')!.sampleSize).toBe(4)
    // digest_gate_fallback_rate = 0/0 → 0 (seed không có DigestGateEvent — P3-M4)
    expect(byKey.get('digest_gate_fallback_rate')!.value).toBe(0)
    expect(byKey.get('digest_gate_fallback_rate')!.sampleSize).toBe(0)
  })

  test('snapshot upsert idempotent: compute 2 lần vẫn 11 row hôm nay', async () => {
    await computeAllKpis()
    await computeAllKpis() // lần 2 — unique date+kpi chặn nhân bản
    const today = todayUtcDate()
    const count = await db.kpiSnapshot.count({ where: { date: today } })
    expect(count).toBe(11)
    // Giá trị snapshot khớp compute (verdict_precision = 0.6667)
    const snap = await db.kpiSnapshot.findUnique({
      where: { date_kpi: { date: today, kpi: 'verdict_precision' } },
    })
    expect(snap).not.toBeNull()
    expect(snap!.value).toBe(0.6667)
    expect(snap!.sampleSize).toBe(6)
    // meta là JSON parse được
    const meta = JSON.parse(snap!.meta) as Record<string, unknown>
    expect(meta.fp).toBe(1)
  })

  test('statusForKpi: dải ±10% đúng cả 2 chiều + target 0 + no_target', () => {
    const higher: KpiDef = { key: 't', label: 't', goal: 'higher', target: 0.8, compute: async () => ({ value: 0, n: 0 }) }
    expect(statusForKpi(higher, 0.8)).toBe('on_target')
    expect(statusForKpi(higher, 0.9)).toBe('on_target')
    expect(statusForKpi(higher, 0.75)).toBe('near') // ≥ 0.72
    expect(statusForKpi(higher, 0.5)).toBe('off')
    const lower: KpiDef = { key: 't', label: 't', goal: 'lower', target: 0.2, compute: async () => ({ value: 0, n: 0 }) }
    expect(statusForKpi(lower, 0.1)).toBe('on_target')
    expect(statusForKpi(lower, 0.21)).toBe('near') // ≤ 0.22
    expect(statusForKpi(lower, 0.5)).toBe('off')
    // target 0 goal lower: mọi giá trị > 0 = off (ngữ nghĩa cảnh báo anomaly)
    const zero: KpiDef = { key: 't', label: 't', goal: 'lower', target: 0, compute: async () => ({ value: 0, n: 0 }) }
    expect(statusForKpi(zero, 0)).toBe('on_target')
    expect(statusForKpi(zero, 2)).toBe('off')
    // không target → no_target (informative)
    const noTarget: KpiDef = { key: 't', label: 't', goal: 'higher', compute: async () => ({ value: 0, n: 0 }) }
    expect(statusForKpi(noTarget, 1)).toBe('no_target')
  })

  test('FB-P1-R1-02: n=0 → status no_data (KHÔNG on_target/off khi chưa đo được)', async () => {
    // Xoá EvalRun → eval_ndcg/eval_recall mất nguồn → n=0, value=0
    await db.evalRun.deleteMany({})
    const results = await computeAllKpis()
    const byKey = new Map(results.map((r) => [r.key, r]))
    for (const key of ['eval_ndcg', 'eval_recall']) {
      const kpi = byKey.get(key)!
      expect(kpi.ok).toBe(true) // không lỗi — chỉ chưa có dữ liệu
      expect(kpi.sampleSize).toBe(0)
      expect(kpi.value).toBe(0)
      // TRƯỚC fix: statusForKpi(0.7-target, value=0) → 'off' — đọc nhầm
      // "kém mục tiêu" cho một phép đo chưa tồn tại. SAU fix: no_data.
      expect(kpi.status).toBe('no_data')
    }
    // KPI còn dữ liệu vẫn tính status bình thường (anomaly_count n=2)
    expect(byKey.get('anomaly_count_24h')!.status).toBe('off')
    expect(byKey.get('anomaly_count_24h')!.sampleSize).toBe(2)
    // Snapshot được update với giá trị mới (value=0, sampleSize=0) — vẫn idempotent
    const today = todayUtcDate()
    const count = await db.kpiSnapshot.count({ where: { date: today } })
    expect(count).toBe(11)
    const snap = await db.kpiSnapshot.findUnique({ where: { date_kpi: { date: today, kpi: 'eval_ndcg' } } })
    expect(snap!.sampleSize).toBe(0)
  })
})
