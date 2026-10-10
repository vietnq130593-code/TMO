/**
 * ROUND-77 TESTS — P4-M2 GHI MODEL LÊN AgentRunRecord + ANOVA SO SÁNH MODEL
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P4-M2, mục #8b — MATH.pdf §ANOVA)
 *
 * Đo lường:
 *   A. buildModelComparison (thuần) — bảng per-model: đếm status đúng
 *      (completed/failed/incomplete/cancelled = terminal; running + status
 *      lạ loại khỏi mẫu số); successRate null khi terminal=0 (không fake 0);
 *      Wilson CI khớp stats/inference.wilsonCI (đối chiếu chéo lib) + cờ
 *      ciUsable đúng guard P2-M2 (n≥5 ∧ width ≤ 0.5); row model null loại
 *      khỏi bảng nhưng đếm nRuns; sắp xếp n giảm dần; ANOVA: đủ 3 model ×
 *      n≥10 → f/p hữu hạn + df đúng; thiếu nhóm/model → null + note chờ
 *      dữ liệu; running rows không đóng góp cycles; suy biến mọi nhóm
 *      bằng nhau → F=0 p=1.
 *   B. metrics-db wiring — insertAgentRunRecordRunning / updateLatestAgentRunRecord
 *      / insertAgentRunRecord nhận + ghi model (khớp THEO runId); update
 *      model=null xoá có chủ đích.
 *   C. fetchModelComparison (DB) — đọc cửa sổ (createdAt default = now nằm
 *      trong cửa sổ): nRuns đếm cả row model null; note undefined khi có
 *      dữ liệu.
 *
 * DB-cô-lập (bunfig preload copy DB) — beforeAll wipe AgentRunRecord.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  buildModelComparison,
  fetchModelComparison,
  ANOVA_MIN_MODELS,
  ANOVA_MIN_N,
  type ModelRunRow,
} from '@/lib/eval/model-comparison'
import { wilsonCI } from '@/lib/stats'
import {
  insertAgentRunRecordRunning,
  insertAgentRunRecord,
  updateLatestAgentRunRecord,
} from '@/lib/metrics-db'

beforeAll(async () => {
  await db.agentRunRecord.deleteMany({})
})

function row(model: string | null, status: string, extra: Partial<ModelRunRow> = {}): ModelRunRow {
  return { model, status, cycles: null, tokensUsed: null, ...extra }
}

// ==================== A. buildModelComparison (thuần) ====================

describe('A. buildModelComparison — bảng per-model', () => {
  test('rỗng → zero-state: models [], note chờ dữ liệu, anova null', () => {
    const r = buildModelComparison([], 90)
    expect(r.models).toEqual([])
    expect(r.nRuns).toBe(0)
    expect(r.nWithModel).toBe(0)
    expect(r.anova.cycles).toBeNull()
    expect(r.anova.tokens).toBeNull()
    expect(r.note).toContain('chưa có AgentRunRecord nào có model')
    expect(r.anova.note).toContain('chờ dữ liệu')
    expect(ANOVA_MIN_MODELS).toBe(3)
    expect(ANOVA_MIN_N).toBe(10)
  })

  test('đếm status đúng — terminal là mẫu số, running + status lạ loại ra', () => {
    const rows: ModelRunRow[] = [
      ...Array.from({ length: 3 }, () => row('model-a', 'completed')),
      row('model-a', 'failed'),
      row('model-a', 'running'),
      row('model-a', 'weird-status'),
      row('model-b', 'completed'),
      row('model-b', 'incomplete'),
      row('model-b', 'cancelled'),
      row(null, 'completed'),
      row(null, 'failed'),
    ]
    const r = buildModelComparison(rows, 90)
    expect(r.models).toHaveLength(2)
    const a = r.models.find(m => m.model === 'model-a')!
    expect(a.n).toBe(6)
    expect(a.completed).toBe(3)
    expect(a.failed).toBe(1)
    expect(a.terminal).toBe(4)
    expect(a.running).toBe(1)
    expect(a.other).toBe(1)
    expect(a.successRate).toBe(0.75) // 3/4 — KHÔNG phải 3/6 (running/weird loại ra)
    const b = r.models.find(m => m.model === 'model-b')!
    expect(b.terminal).toBe(3)
    expect(b.successRate).toBe(Math.round((1 / 3) * 10000) / 10000)
    // Row model null: loại khỏi bảng nhưng đếm nRuns (6 + 3 + 2 = 11)
    expect(r.nRuns).toBe(11)
    expect(r.nWithModel).toBe(9)
  })

  test('terminal=0 → successRate null + CI null (không fake 0)', () => {
    const r = buildModelComparison([row('m', 'running'), row('m', 'running')], 90)
    const m = r.models[0]
    expect(m.terminal).toBe(0)
    expect(m.successRate).toBeNull()
    expect(m.successCI).toBeNull()
    expect(m.ciUsable).toBe(false)
  })

  test('Wilson CI khớp lib wilsonCI + ciUsable đúng guard P2-M2 (n≥5 ∧ width ≤ 0.5)', () => {
    // model-small: 3/4 terminal (n=4 < 5 → không dùng được)
    const small: ModelRunRow[] = [
      ...Array.from({ length: 3 }, () => row('model-small', 'completed')),
      row('model-small', 'failed'),
    ]
    // model-big: 16/20 terminal (n=20, p=0.8 → width ≈ 0.335 ≤ 0.5 → dùng được)
    const big: ModelRunRow[] = [
      ...Array.from({ length: 16 }, () => row('model-big', 'completed')),
      ...Array.from({ length: 4 }, () => row('model-big', 'failed')),
    ]
    const r = buildModelComparison([...small, ...big], 90)
    const s = r.models.find(m => m.model === 'model-small')!
    const b = r.models.find(m => m.model === 'model-big')!
    // Đối chiếu chéo lib (P2-M2) — cùng công thức Wilson
    const ws = wilsonCI(0.75, 4)
    expect(s.successCI!.low).toBe(Math.round(ws.low * 10000) / 10000)
    expect(s.successCI!.high).toBe(Math.round(ws.high * 10000) / 10000)
    expect(s.ciUsable).toBe(false) // n=4 < 5
    expect(b.successRate).toBe(0.8)
    expect(b.ciUsable).toBe(true) // n=20 ≥ 5 và width ≈ 0.335 ≤ 0.5
    const wb = wilsonCI(0.8, 20)
    expect(b.successCI!.high - b.successCI!.low).toBeLessThanOrEqual(0.5)
    expect(Math.abs(b.successCI!.low - Math.round(wb.low * 10000) / 10000)).toBeLessThan(5e-5 + 1e-9)
    // Sắp xếp n giảm dần
    expect(r.models[0].model).toBe('model-big')
  })

  test('ANOVA cycles: 3 model × n≥10 → f/p hữu hạn, df 2/27, p nhỏ (means xa nhau)', () => {
    const A = [10, 12, 14, 16, 18, 20, 22, 24, 26, 28]
    const B = [30, 31, 32, 33, 34, 35, 36, 37, 38, 39]
    const C = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49]
    const rows: ModelRunRow[] = [
      ...A.map(v => row('ma', 'completed', { cycles: v })),
      ...B.map(v => row('mb', 'completed', { cycles: v })),
      ...C.map(v => row('mc', 'completed', { cycles: v })),
    ]
    const r = buildModelComparison(rows, 90)
    expect(r.anova.cycles).not.toBeNull()
    expect(r.anova.cycles!.dfBetween).toBe(2)
    expect(r.anova.cycles!.dfWithin).toBe(27)
    // Tay: SSB=10·[(19−32.667)²+(34.5−32.667)²+(44.5−32.667)²]=3301.67, MSB=1650.83;
    // SSW=330+82.5+82.5=495, MSW=18.33 → F ≈ 90.05 (df 2/27)
    expect(r.anova.cycles!.f).toBeGreaterThan(80)
    expect(r.anova.cycles!.f).toBeLessThan(100)
    expect(r.anova.cycles!.p).toBeLessThan(0.001)
    expect(r.anova.cycles!.groups.map(g => g.n)).toEqual([10, 10, 10])
    expect(r.anova.note).toContain('cycles')
  })

  test('ANOVA tokens song song + tokens không có → null (chỉ cycles đủ)', () => {
    const A = Array.from({ length: 10 }, (_, i) => row('ma', 'completed', { cycles: 10 + i }))
    const B = Array.from({ length: 10 }, (_, i) => row('mb', 'completed', { cycles: 20 + i }))
    const C = Array.from({ length: 10 }, (_, i) => row('mc', 'completed', { cycles: 30 + i }))
    const r = buildModelComparison([...A, ...B, ...C], 90)
    expect(r.anova.cycles).not.toBeNull()
    expect(r.anova.tokens).toBeNull() // không seed tokensUsed
  })

  test('ANOVA thiếu nhóm: 2 model → null + note; model n=9 bị loại → null', () => {
    const two = [
      ...Array.from({ length: 10 }, (_, i) => row('ma', 'completed', { cycles: i })),
      ...Array.from({ length: 10 }, (_, i) => row('mb', 'completed', { cycles: i })),
    ]
    expect(buildModelComparison(two, 90).anova.cycles).toBeNull()

    const thirdSmall = [
      ...two,
      ...Array.from({ length: 9 }, (_, i) => row('mc', 'completed', { cycles: i })), // n=9 < 10
    ]
    expect(buildModelComparison(thirdSmall, 90).anova.cycles).toBeNull()
    expect(buildModelComparison(thirdSmall, 90).anova.note).toContain('chờ dữ liệu')
  })

  test('running rows KHÔNG đóng góp cycles vào ANOVA', () => {
    const rows: ModelRunRow[] = [
      // 3 model đủ n=10 terminal nhưng KHÔNG có cycles; 5 running có cycles 100
      ...Array.from({ length: 10 }, () => row('ma', 'completed')),
      ...Array.from({ length: 10 }, () => row('mb', 'completed')),
      ...Array.from({ length: 10 }, () => row('mc', 'completed')),
      ...Array.from({ length: 5 }, () => row('ma', 'running', { cycles: 100 })),
    ]
    const r = buildModelComparison(rows, 90)
    expect(r.anova.cycles).toBeNull()
  })

  test('ANOVA suy biến: mọi nhóm cycles hằng bằng nhau → F=0, p=1', () => {
    const rows: ModelRunRow[] = [
      ...Array.from({ length: 10 }, () => row('ma', 'completed', { cycles: 7 })),
      ...Array.from({ length: 10 }, () => row('mb', 'completed', { cycles: 7 })),
      ...Array.from({ length: 10 }, () => row('mc', 'completed', { cycles: 7 })),
    ]
    const r = buildModelComparison(rows, 90)
    expect(r.anova.cycles).not.toBeNull()
    expect(r.anova.cycles!.f).toBe(0)
    expect(r.anova.cycles!.p).toBe(1)
  })
})

// ==================== B. metrics-db wiring — model ghi xuống DB ====================

describe('B. metrics-db — insert/update nhận model (P4-M2)', () => {
  test('insertAgentRunRecordRunning ghi model ngay từ lúc start', async () => {
    await insertAgentRunRecordRunning({
      sessionId: 'mc-wire-1',
      agentId: 'omega',
      agentName: 'OMEGA',
      runId: 'run_mc_wire_1',
      model: 'moonshotai/kimi-k3',
    })
    const rows = await db.agentRunRecord.findMany({ where: { sessionId: 'mc-wire-1' } })
    expect(rows).toHaveLength(1)
    expect(rows[0].model).toBe('moonshotai/kimi-k3')
    expect(rows[0].status).toBe('running')
  })

  test('updateLatestAgentRunRecord khớp THEO runId và set model', async () => {
    // Row khác chen giữa (delegation) — update phải không nhầm
    await insertAgentRunRecordRunning({
      sessionId: 'mc-wire-2',
      agentName: 'OMEGA',
      runId: 'run_mc_wire_2',
      model: 'space-bunny-free',
    })
    await insertAgentRunRecordRunning({
      sessionId: 'mc-wire-2',
      agentName: 'MEGATRON',
      runId: 'sub_mc_wire_2',
      parentRunId: 'run_mc_wire_2',
      model: 'space-bunny-free',
    })
    const n = await updateLatestAgentRunRecord(
      'mc-wire-2',
      { status: 'completed', complete: true, model: 'moonshotai/kimi-k3' },
      'run_mc_wire_2',
    )
    expect(n).toBe(1)
    const parent = await db.agentRunRecord.findFirst({ where: { sessionId: 'mc-wire-2', runId: 'run_mc_wire_2' } })
    const sub = await db.agentRunRecord.findFirst({ where: { sessionId: 'mc-wire-2', runId: 'sub_mc_wire_2' } })
    expect(parent?.model).toBe('moonshotai/kimi-k3')
    expect(parent?.status).toBe('completed')
    expect(sub?.status).toBe('running') // delegation row KHÔNG bị đụng
  })

  test('update model=null xoá có chủ đích (chữ kí vẫn chạy)', async () => {
    await updateLatestAgentRunRecord('mc-wire-1', { model: null }, 'run_mc_wire_1')
    const r = await db.agentRunRecord.findFirst({ where: { sessionId: 'mc-wire-1' } })
    expect(r?.model).toBeNull()
  })

  test('insertAgentRunRecord (fallback full) nhận model', async () => {
    await insertAgentRunRecord({
      sessionId: 'mc-wire-3',
      agentName: 'OMEGA',
      runId: 'run_mc_wire_3',
      model: 'space-bunny-free',
      status: 'completed',
      stopReason: 'complete',
      toolCalls: 5,
      toolFailures: 0,
      durationMs: 1000,
      complete: true,
      startedAt: new Date(Date.now() - 1000),
      completedAt: new Date(),
      cycles: 3,
      tokensUsed: 1234,
    })
    const r = await db.agentRunRecord.findFirst({ where: { sessionId: 'mc-wire-3' } })
    expect(r?.model).toBe('space-bunny-free')
    expect(r?.cycles).toBe(3)
  })
})

// ==================== C. fetchModelComparison (DB) ====================

describe('C. fetchModelComparison — đọc cửa sổ DB', () => {
  test('seed 2 model + 1 row model-null → báo cáo đúng cấu trúc', async () => {
    await db.agentRunRecord.deleteMany({})
    for (let i = 0; i < 7; i++) {
      await db.agentRunRecord.create({
        data: { sessionId: 'mc-fetch-1', model: 'space-bunny-free', status: i < 5 ? 'completed' : 'failed', cycles: 4 + i },
      })
    }
    for (let i = 0; i < 3; i++) {
      await db.agentRunRecord.create({
        data: { sessionId: 'mc-fetch-2', model: 'moonshotai/kimi-k3', status: 'completed', cycles: 9 + i },
      })
    }
    await db.agentRunRecord.create({ data: { sessionId: 'mc-fetch-3', status: 'completed', cycles: 1 } }) // model null

    const r = await fetchModelComparison(90)
    expect(r.windowDays).toBe(90)
    expect(r.nRuns).toBe(11) // gồm cả row model null
    expect(r.nWithModel).toBe(10)
    expect(r.note).toBeUndefined() // có dữ liệu lành
    const sbf = r.models.find(m => m.model === 'space-bunny-free')!
    expect(sbf.n).toBe(7)
    expect(sbf.completed).toBe(5)
    expect(sbf.failed).toBe(2)
    expect(sbf.terminal).toBe(7)
    expect(sbf.successRate).toBe(Math.round((5 / 7) * 10000) / 10000)
    const k3 = r.models.find(m => m.model === 'moonshotai/kimi-k3')!
    expect(k3.successRate).toBe(1)
    // Sắp xếp n giảm dần
    expect(r.models[0].model).toBe('space-bunny-free')
    // ANOVA: chỉ 2 model → null (chờ dữ liệu)
    expect(r.anova.cycles).toBeNull()
    expect(r.anova.note).toContain('chờ dữ liệu')
    expect(r.generatedAt).toBeTruthy()
  })
})
