/**
 * R122 TESTS — OBS-V3 (BLUEPRINT-OBSERVATION-V3-P5-P8 — R34 triển khai)
 * ============================================================================
 * Giao thức quan sát mở rộng theo kiến trúc 4 não + NAS/EVO. Đo lường:
 *
 *   A. kinds.ts — 6 kind mới đăng ký đúng nhóm (eval.run · kb.consult ·
 *      learn.escalate · adapt.escalate · model.failover · chat.fastpath).
 *   B. observeEventThrottled (H7) — throttle in-memory theo khóa: lần 1 ghi,
 *      lần 2 trong cửa sổ bị nuốt, khóa khác ghi, windowMs 0 cho phép lại,
 *      resetObservationThrottle dọn state.
 *   C. Pure 5 rule thế hệ 2 (OBS-P6) — pin biên strict: evo-stuck > 5 phút ·
 *      eval-starvation 2 run liên tiếp 100% refusal · train-gate ≥ 3 ·
 *      provider-degraded ≥ 3 · evo-budget-burn nAbandoned ≥ 3 VÀ tỉ lệ > 50%.
 *   D. buildEvoSessionSwept (H4b) — payload swept:true + staleMinutes.
 *   E. Rule engine DB (cờ obs_alerts + obs_ledger on) — evo-stuck phát đúng
 *      run stale + dedup tick 2 · eval-starvation âm bản (có answered) rồi
 *      dương bản (2 run refusal) · train-gate-repeat theo não ·
 *      provider-degraded theo (provider, model) · evo-budget-burn theo run.
 *   F. H2 kb.consult — logKbConsult phát sự kiện: queryHash SHA-256 12 ký tự,
 *      KHÔNG lộ nội dung truy vấn (RO-V3-2 chốt).
 *   G. H6 adapt.escalate — consumeEscalationEmit phát đúng 1 lần/session.
 *   H. OBS-P7 impact pass 2 — proposal.apply đủ 24h + snapshot 2 bên →
 *      impact.estimate anchor 'evo-deploy' + dedup evoDeploySeq lần 2.
 *
 * DB CÔ LẬP qua preload (tests/db-isolation-preload.ts) — pattern r95/r98/r99.
 * State process (dedupe + throttle + adaptation store) reset giữa các cụm.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import { setTuningValue, refreshTuningSnapshot } from '@/lib/learning/tuning-store'
import { OBS_KINDS, obsKindDef, type ObsKindGroup } from '@/lib/observation/kinds'
import {
  observeEventThrottled, resetObservationThrottle, flushObservationQueue,
  isObsLedgerEnabled, OBS_THROTTLE_WINDOW_MS,
} from '@/lib/observation/ledger'
import {
  shouldAlertEvoStuck, shouldAlertEvalStarvation, shouldAlertTrainGateRepeat,
  shouldAlertProviderDegraded, shouldAlertEvoBudgetBurn,
  runAlertChecks, resetAlertDedupState,
  ALERT_EVO_STUCK_AFTER_MS, ALERT_TRAIN_GATE_LIMIT,
  ALERT_PROVIDER_DEGRADED_LIMIT, ALERT_EVO_BURN_MIN_ABANDONED, ALERT_EVO_BURN_RATIO,
} from '@/lib/observation/alerts'
import { computeProposalApplyImpactEstimates } from '@/lib/observation/impact'
import { logKbConsult } from '@/lib/kb-routing/consult-log'
import {
  applyAdaptationToSession, hasEscalation, consumeEscalationEmit,
} from '@/lib/learning/adaptation-engine'
import { buildEvoSessionSwept } from '@/lib/brain/evo/observe'

const MIN = 60_000

async function nextSeq(): Promise<number> {
  const mx = (await db.observationEvent.findFirst({ orderBy: { seq: 'desc' } }))?.seq ?? 0
  return mx + 1
}

async function seedEvent(evt: {
  kind: string; payloadJson: string; ts?: Date; runId?: string; summary?: string
}): Promise<void> {
  await db.observationEvent.create({
    data: {
      seq: await nextSeq(),
      actor: 'system:r122',
      kind: evt.kind,
      summary: evt.summary ?? `r122 seed ${evt.kind}`,
      payloadJson: evt.payloadJson,
      ts: evt.ts ?? new Date(),
      runId: evt.runId ?? null,
    },
  })
}

async function alertPayloads(since?: Date): Promise<Array<Record<string, unknown>>> {
  const rows = await db.observationEvent.findMany({
    where: { kind: 'obs.alert', ...(since ? { ts: { gte: since } } : {}) },
    orderBy: { ts: 'desc' },
    select: { payloadJson: true },
    take: 300,
  })
  return rows.flatMap(r => {
    try {
      return [JSON.parse(r.payloadJson) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

beforeAll(async () => {
  // Cờ ON cho toàn file (STORE layer — hiệu lực ngay; DB cô lập không chạm prod)
  await setTuningValue('obs_ledger', 'on')
  await setTuningValue('obs_alerts', 'on')
  await setTuningValue('kb_consult_log', 'on')
  await refreshTuningSnapshot()
  expect(isObsLedgerEnabled()).toBe(true)
  await flushObservationQueue()
})

// ==================== A. kinds OBS-V3 ====================

describe('r122 · A — 6 kind mới đăng ký đúng nhóm (OBS-V3)', () => {
  test('A1 đủ kind + đúng nhóm (chip UI + filter bar)', () => {
    const expectKind = (kind: string, group: ObsKindGroup) => {
      const def = obsKindDef(kind)
      expect(def, `kind ${kind} phải đăng ký OBS_KINDS`).not.toBeNull()
      expect(def!.group).toBe(group)
      expect(def!.label.length).toBeGreaterThan(0)
    }
    expectKind('eval.run', 'brain')
    expectKind('kb.consult', 'db')
    expectKind('learn.escalate', 'db')
    expectKind('adapt.escalate', 'alert')
    expectKind('model.failover', 'tuning')
    expectKind('chat.fastpath', 'run')
    // tổng 25 (r99-C1 pin đồng bộ — PIN UPDATE R34)
    expect(OBS_KINDS.length).toBe(25)
  })
})

// ==================== B. observeEventThrottled (H7) ====================

describe('r122 · B — observeEventThrottled (throttle in-memory theo khóa)', () => {
  test('B1 lần 1 ghi · lần 2 trong cửa sổ nuốt · khóa khác ghi · windowMs 0 mở lại · reset dọn', async () => {
    resetObservationThrottle()
    const kind = 'r122.throttle.test'
    const mkEvt = (n: number) => ({
      actor: 'system:r122', kind, summary: `r122 throttle ${n}`, payload: { n },
    })
    const count = async () => db.observationEvent.count({ where: { kind } })

    observeEventThrottled('r122:keyA', mkEvt(1))
    await flushObservationQueue()
    expect(await count()).toBe(1) // lần 1 — ghi

    observeEventThrottled('r122:keyA', mkEvt(2))
    observeEventThrottled('r122:keyA', mkEvt(3))
    await flushObservationQueue()
    expect(await count()).toBe(1) // cùng khóa trong cửa sổ — nuốt

    observeEventThrottled('r122:keyB', mkEvt(4))
    await flushObservationQueue()
    expect(await count()).toBe(2) // khóa khác — ghi

    // windowMs 0 — mọi lần đều được phép (cửa sổ rỗng)
    observeEventThrottled('r122:keyA', mkEvt(5), { windowMs: 0 })
    await flushObservationQueue()
    expect(await count()).toBe(3)

    // reset dọn state — keyA được phép lại (dùng cửa sổ mặc định)
    resetObservationThrottle()
    observeEventThrottled('r122:keyA', mkEvt(6))
    await flushObservationQueue()
    expect(await count()).toBe(4)

    // hằng số cửa sổ mặc định 10 phút (H7 — chống spam khi model chết)
    expect(OBS_THROTTLE_WINDOW_MS).toBe(10 * 60_000)
  })
})

// ==================== C. Pure 5 rule thế hệ 2 (OBS-P6) ====================

describe('r122 · C — pure thresholds (pin biên strict)', () => {
  test('C1 shouldAlertEvoStuck — strict > 5 phút', () => {
    const now = 1_000_000_000
    expect(ALERT_EVO_STUCK_AFTER_MS).toBe(5 * 60_000)
    expect(shouldAlertEvoStuck(now - 5 * 60_000, now)).toBe(false) // đúng 5' — chưa
    expect(shouldAlertEvoStuck(now - 5 * 60_000 - 1, now)).toBe(true) // 5'+1ms — stuck
    expect(shouldAlertEvoStuck(now - 4 * 60_000, now)).toBe(false)
  })

  test('C2 shouldAlertEvalStarvation — 2 run liên tiếp 100% refusal', () => {
    // 2 run đều 100% refusal → true
    expect(shouldAlertEvalStarvation([
      { caseCount: 36, refusalCount: 36 },
      { caseCount: 10, refusalCount: 10 },
    ])).toBe(true)
    // run mới nhất có answered → false
    expect(shouldAlertEvalStarvation([
      { caseCount: 10, refusalCount: 3 },
      { caseCount: 36, refusalCount: 36 },
    ])).toBe(false)
    // chỉ 1 run → false (chưa đủ bằng chứng)
    expect(shouldAlertEvalStarvation([{ caseCount: 10, refusalCount: 10 }])).toBe(false)
    // caseCount 0 → false (không tin được)
    expect(shouldAlertEvalStarvation([
      { caseCount: 0, refusalCount: 0 },
      { caseCount: 0, refusalCount: 0 },
    ])).toBe(false)
    // run thứ 3 (cũ hơn) không tính — chỉ 2 gần nhất
    expect(shouldAlertEvalStarvation([
      { caseCount: 10, refusalCount: 10 },
      { caseCount: 10, refusalCount: 10 },
      { caseCount: 10, refusalCount: 1 },
    ])).toBe(true)
  })

  test('C3 shouldAlertTrainGateRepeat — strict ≥ 3', () => {
    expect(ALERT_TRAIN_GATE_LIMIT).toBe(3)
    expect(shouldAlertTrainGateRepeat(2)).toBe(false)
    expect(shouldAlertTrainGateRepeat(3)).toBe(true)
  })

  test('C4 shouldAlertProviderDegraded — strict ≥ 3', () => {
    expect(ALERT_PROVIDER_DEGRADED_LIMIT).toBe(3)
    expect(shouldAlertProviderDegraded(2)).toBe(false)
    expect(shouldAlertProviderDegraded(3)).toBe(true)
  })

  test('C5 shouldAlertEvoBudgetBurn — nAbandoned ≥ 3 VÀ tỉ lệ > 50% (strict >)', () => {
    expect(ALERT_EVO_BURN_MIN_ABANDONED).toBe(3)
    expect(ALERT_EVO_BURN_RATIO).toBe(0.5)
    expect(shouldAlertEvoBudgetBurn(5, 8)).toBe(true)   // 62,5%
    expect(shouldAlertEvoBudgetBurn(4, 8)).toBe(false)  // đúng 50% — chưa "quá nửa"
    expect(shouldAlertEvoBudgetBurn(2, 2)).toBe(false)  // 100% nhưng < 3 abandon
    expect(shouldAlertEvoBudgetBurn(0, 10)).toBe(false)
    expect(shouldAlertEvoBudgetBurn(3, 0)).toBe(false)  // candidatesMax 0 — vô nghĩa
  })
})

// ==================== D. buildEvoSessionSwept (H4b) ====================

describe('r122 · D — buildEvoSessionSwept (sweep mồ côi phát sự kiện)', () => {
  test('D1 payload swept:true + phase end + status failed + staleMinutes làm tròn', () => {
    const evt = buildEvoSessionSwept({ brain: 'calibration_v3', runId: 'run_abc123def', staleMs: 90_000 })
    expect(evt.payload.phase).toBe('end')
    expect(evt.payload.swept).toBe(true)
    expect(evt.payload.status).toBe('failed')
    expect(evt.payload.brain).toBe('calibration_v3')
    expect(evt.payload.runId).toBe('run_abc123def')
    expect(evt.payload.staleMinutes).toBe(2) // 90s → 1,5' → round 2
    expect(evt.summary).toContain('SWEEP')
    expect(evt.summary).toContain('calibration_v3')
    // stale < 1 phút vẫn tối thiểu 1 (trung thực "ít nhất 1 phút")
    expect(buildEvoSessionSwept({ brain: 'b', runId: 'r', staleMs: 5_000 }).payload.staleMinutes).toBe(1)
  })
})

// ==================== E. Rule engine DB (OBS-P6) ====================

describe('r122 · E — runAlertChecks thế hệ 2 (DB cô lập)', () => {
  test('E1 evo-stuck — run stale 10\' phát alert; run tươi không; tick 2 dedup', async () => {
    resetAlertDedupState()
    await flushObservationQueue()
    const stale = await db.brainSearchRun.create({
      data: {
        brain: 'r122_stuck_brain', status: 'running', seed: 42,
        heartbeatAt: new Date(Date.now() - 10 * MIN),
        dataFingerprint: 'r122', inputMode: 'evo-144',
        candidatesMax: 8, wallMsMax: 600_000,
      },
    })
    await db.brainSearchRun.create({
      data: {
        brain: 'r122_fresh_brain', status: 'running', seed: 43,
        heartbeatAt: new Date(), // tươi — không alert
        dataFingerprint: 'r122', inputMode: 'evo-144',
        candidatesMax: 8, wallMsMax: 600_000,
      },
    })
    const marker = new Date()
    await runAlertChecks()
    let alerts = (await alertPayloads(marker)).filter(p => p.rule === 'evo-stuck')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].targetId).toBe(`brain_search_run:${stale.id}`)
    expect(alerts[0].staleMinutes).toBe(10)
    expect(String(alerts[0].brain)).toBe('r122_stuck_brain')

    // tick 2 — dedup 1h: không phát lại
    await runAlertChecks()
    alerts = (await alertPayloads(marker)).filter(p => p.rule === 'evo-stuck')
    expect(alerts).toHaveLength(1)
  })

  test('E2 eval-starvation — có answered (âm bản) rồi 2 run refusal (dương bản)', async () => {
    resetAlertDedupState()
    // DỌN alert eval-starvation có sẵn trong bản copy: E1 đã chạy runAlertChecks
    // trên dữ liệu THẬT (R33 36/36 + auto-eval 8/8 — đều 100% refusal) → 1 alert
    // đã phát → dedup 1h sẽ chặn đột dương bản của E2. DB test là BẢN COPY —
    // xoá an toàn (pattern r99: cô lập theo rule).
    for (const row of await db.observationEvent.findMany({
      where: { kind: 'obs.alert' }, select: { id: true, payloadJson: true },
    })) {
      try {
        const p = JSON.parse(row.payloadJson) as { rule?: string }
        if (p.rule === 'eval-starvation') await db.observationEvent.delete({ where: { id: row.id } })
      } catch { /* payload rác — bỏ qua */ }
    }
    await flushObservationQueue()
    // ÂM BẢN: run mới nhất CÓ answered → cặp gần nhất không thể cùng 100% refusal
    await db.evalRun.create({
      data: {
        status: 'completed', caseCount: 10, refusalCount: 3, answeredCount: 7,
        startedAt: new Date(Date.now() - 90_000), completedAt: new Date(Date.now() - 60_000),
      },
    })
    await db.evalRun.create({
      data: {
        status: 'completed', caseCount: 10, refusalCount: 10, answeredCount: 0,
        startedAt: new Date(Date.now() - 150_000), completedAt: new Date(Date.now() - 120_000),
      },
    })
    let marker = new Date()
    await runAlertChecks()
    expect((await alertPayloads(marker)).filter(p => p.rule === 'eval-starvation')).toHaveLength(0)

    // DƯƠNG BẢN: 2 run refusal mới nhất (mới hơn bản âm) → phát
    await db.evalRun.create({
      data: {
        status: 'completed', caseCount: 12, refusalCount: 12, answeredCount: 0,
        startedAt: new Date(Date.now() - 30_000), completedAt: new Date(),
      },
    })
    await db.evalRun.create({
      data: {
        status: 'completed', caseCount: 9, refusalCount: 9, answeredCount: 0,
        startedAt: new Date(Date.now() - 20_000), completedAt: new Date(),
      },
    })
    marker = new Date()
    await runAlertChecks()
    const alerts = (await alertPayloads(marker)).filter(p => p.rule === 'eval-starvation')
    expect(alerts).toHaveLength(1)
    const runs = alerts[0].runs as Array<{ caseCount: number; refusalCount: number }>
    expect(runs).toHaveLength(2)
    expect(runs.every(r => r.refusalCount >= r.caseCount)).toBe(true)
  })

  test('E3 train-gate-repeat — 3 lần trained=false cùng não phát; 2 lần không', async () => {
    resetAlertDedupState()
    await flushObservationQueue()
    // não duy nhất tên r122 — không dính dữ liệu thật trong bản copy
    const mk = (brain: string) => JSON.stringify({
      phase: 'end', brain, trained: false, resultError: 'class imbalance r122',
    })
    await seedEvent({ kind: 'brain.train', payloadJson: mk('r122_gate_brain') })
    await seedEvent({ kind: 'brain.train', payloadJson: mk('r122_gate_brain') })
    let marker = new Date()
    await runAlertChecks()
    expect((await alertPayloads(marker)).filter(
      p => p.rule === 'train-gate-repeat' && p.targetId === 'brain:r122_gate_brain',
    )).toHaveLength(0) // 2 lần — chưa

    await seedEvent({ kind: 'brain.train', payloadJson: mk('r122_gate_brain') })
    marker = new Date()
    await runAlertChecks()
    const alerts = (await alertPayloads(marker)).filter(
      p => p.rule === 'train-gate-repeat' && p.targetId === 'brain:r122_gate_brain',
    )
    expect(alerts).toHaveLength(1)
    expect(alerts[0].blockedCount).toBe(3)
    expect(String(alerts[0].latestError)).toContain('class imbalance')
  })

  test('E4 provider-degraded — 3 fail cùng (provider, model) phát alert', async () => {
    resetAlertDedupState()
    await flushObservationQueue()
    const mk = JSON.stringify({
      provider: 'r122prov', model: 'r122-model-x', taskLabel: 't', path: 'nim-rotation',
      error: 'HTTP 403 FreeTierError r122',
    })
    await seedEvent({ kind: 'model.failover', payloadJson: mk })
    await seedEvent({ kind: 'model.failover', payloadJson: mk })
    await seedEvent({ kind: 'model.failover', payloadJson: mk })
    const marker = new Date()
    await runAlertChecks()
    const alerts = (await alertPayloads(marker)).filter(p => p.rule === 'provider-degraded')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].targetId).toBe('provider:r122prov:r122-model-x')
    expect(alerts[0].failCount).toBe(3)
  })

  test('E5 evo-budget-burn — nAbandoned 5/8 phát alert đúng run', async () => {
    resetAlertDedupState()
    await flushObservationQueue()
    await seedEvent({
      kind: 'search.session',
      payloadJson: JSON.stringify({
        phase: 'end', brain: 'r122_burn_brain', runId: 'r122evo_burn',
        nAbandoned: 5, candidatesMax: 8, status: 'done',
      }),
    })
    const marker = new Date()
    await runAlertChecks()
    const alerts = (await alertPayloads(marker)).filter(p => p.rule === 'evo-budget-burn')
    expect(alerts).toHaveLength(1)
    expect(alerts[0].targetId).toBe('brain_search_run:r122evo_burn')
    expect(alerts[0].nAbandoned).toBe(5)
    expect(alerts[0].candidatesMax).toBe(8)
  })
})

// ==================== F. H2 — kb.consult ====================

describe('r122 · F — logKbConsult phát kb.consult (queryHash thay nội dung)', () => {
  test('F1 row KbConsultLog + sự kiện kb.consult · KHÔNG lộ nội dung truy vấn', async () => {
    const secret = 'NỘI DUNG TRUY VẤN BÍ MẬT r122xyz'
    await logKbConsult({
      taskType: 'chat', intent: 'factual', queryText: secret,
      retrievalConfig: { topK: 5 }, sources: { chunks: 3 }, topResults: [{ id: 'c1', score: 0.9 }],
      confidence: 0.62, rawConfidence: 0.55, tokensUsed: 120, latencyMs: 210,
      runId: 'r122_kb_run', sessionId: 'r122_kb_session',
    })
    await flushObservationQueue()

    const row = await db.observationEvent.findFirst({
      where: { kind: 'kb.consult', runId: 'r122_kb_run' },
    })
    expect(row).not.toBeNull()
    expect(row!.summary).toContain('KB consult [chat]')
    expect(row!.summary).toContain('conf 0.62')
    // RO-V3-2: KHÔNG lộ nội dung — summary lẫn payload
    expect(row!.summary).not.toContain('BÍ MẬT')
    expect(row!.payloadJson).not.toContain('BÍ MẬT')
    const p = JSON.parse(row!.payloadJson) as { queryHash?: string; nTop?: number; taskType?: string }
    expect(p.queryHash).toMatch(/^[0-9a-f]{12}$/) // SHA-256 12 ký tự hex
    expect(p.nTop).toBe(1)
    expect(p.taskType).toBe('chat')
    // KbConsultLog row thật cũng đã ghi (single-source hook)
    const kbl = await db.kbConsultLog.findFirst({ where: { runId: 'r122_kb_run' } })
    expect(kbl).not.toBeNull()
  })
})

// ==================== G. H6 — adapt.escalate ====================

describe('r122 · G — consumeEscalationEmit phát adapt.escalate đúng 1 lần/session', () => {
  test('G1 lần đầu true + sự kiện; lần sau false không phát thêm', async () => {
    const sid = 'r122-adapt-session-1'
    applyAdaptationToSession(sid, {
      shouldAdapt: true,
      currentStrategy: 'default',
      recommendedStrategy: 'escalate_to_user',
      reason: 'r122 lỗi lặp ≥3 cách',
      confidence: 0.9,
    })
    expect(hasEscalation(sid)).toBe(true)
    const before = await db.observationEvent.count({ where: { kind: 'adapt.escalate' } })
    expect(consumeEscalationEmit(sid)).toBe(true)
    // fire-and-forget qua dynamic import — đợi promise import settle rồi flush
    // (flushObservationQueue chỉ đợi queue ĐÃ vào; observeEvent chưa vào queue
    // nếu promise import chưa resolve — khác call-site static import)
    await new Promise(r => setTimeout(r, 150))
    await flushObservationQueue()
    const after = await db.observationEvent.count({ where: { kind: 'adapt.escalate' } })
    expect(after).toBe(before + 1)
    const row = await db.observationEvent.findFirst({
      where: { kind: 'adapt.escalate', sessionId: sid },
    })
    expect(row).not.toBeNull()
    expect(row!.summary).toContain('TẠM DỪNG')

    // lần 2 — false, KHÔNG phát thêm (emit-once ROUND-38 F8 giữ nguyên)
    expect(consumeEscalationEmit(sid)).toBe(false)
    await flushObservationQueue()
    expect(await db.observationEvent.count({ where: { kind: 'adapt.escalate' } })).toBe(after)
  })
})

// ==================== H. OBS-P7 — impact pass 2 (anchor evo-deploy) ====================

describe('r122 · H — computeProposalApplyImpactEstimates (neo EVO-deploy)', () => {
  test('H1 proposal.apply đủ 24h + snapshot 2 bên → impact.estimate anchor evo-deploy; lần 2 dedup', async () => {
    const changedAt = new Date(Date.now() - 25 * 3600_000)
    const beforeDay = new Date(changedAt.getTime() - 24 * 3600_000).toISOString().slice(0, 10)
    const afterDay = new Date(changedAt.getTime() + 24 * 3600_000).toISOString().slice(0, 10)
    // KPI riêng của test — không dính KPI thật trong bản copy
    await db.kpiSnapshot.create({ data: { date: beforeDay, kpi: 'r122_kpi', value: 0.4, sampleSize: 50 } })
    await db.kpiSnapshot.create({ data: { date: afterDay, kpi: 'r122_kpi', value: 0.5, sampleSize: 60 } })

    const seq = await nextSeq()
    await db.observationEvent.create({
      data: {
        seq, actor: 'user', kind: 'proposal.apply',
        summary: 'r122 ÁP DỤNG kiến trúc calibration_v3 v9 ACTIVE',
        payloadJson: JSON.stringify({
          brain: 'calibration_v3', version: 9, active: true, improved: true,
          origin: 'evo-deploy', archSummary: '16·tanh → 8·tanh',
        }),
        ts: changedAt,
      },
    })

    const written = await computeProposalApplyImpactEstimates()
    expect(written).toBeGreaterThanOrEqual(1)
    await flushObservationQueue()
    const row = await db.observationEvent.findFirst({
      where: { kind: 'impact.estimate', payloadJson: { contains: '"evoDeploySeq":' } },
      orderBy: { ts: 'desc' },
    })
    expect(row).not.toBeNull()
    const p = JSON.parse(row!.payloadJson) as {
      anchor?: string; evoDeploySeq?: number; kpis?: Array<{ kpi: string; delta: number }>
    }
    expect(p.anchor).toBe('evo-deploy')
    expect(p.evoDeploySeq).toBe(seq)
    const kpi = p.kpis?.find(k => k.kpi === 'r122_kpi')
    expect(kpi).toBeDefined()
    expect(kpi!.delta).toBeCloseTo(0.1, 6) // 0,5 − 0,4
    // framing trung thực RO-6
    expect(row!.summary).toContain('correlation')

    // lần 2 — dedup theo evoDeploySeq: không ghi THÊM cho seq này
    await computeProposalApplyImpactEstimates()
    await flushObservationQueue()
    const count = await db.observationEvent.count({
      where: { kind: 'impact.estimate', payloadJson: { contains: `"evoDeploySeq":${seq}` } },
    })
    expect(count).toBe(1)
  })
})
