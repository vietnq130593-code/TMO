/**
 * ROUND-96 TESTS — OBS-P2 · BRAIN INFERENCE TRACE + TIMELINE API
 * (BLUEPRINT-OBSERVATION-P1-P4 §C.2/C.4 — chốt §7 Task 23 2026-10-13)
 *
 * Đo lường:
 *   A. traceInference hash-only (Q2 §7 chốt — obs_brain_trace off):
 *      BrainInferenceTrace row inputHash SHA-256 64-hex khớp hashObsInput,
 *      inputJson/outputJson NULL, latencyMs + modelVersion provenance; kèm 1
 *      sự kiện brain.infer-ref (table/rowKey trỏ trace — timeline 1 nguồn C.4).
 *   B. obs_brain_trace on → inputJson/outputJson đầy đủ; vector lớn → cap 2KB
 *      + truncated; B2 đa byte — cap theo BYTE UTF-8 không .length (FB-OBS-R1-03).
 *   C. hashObsInput tất định — cùng input cùng hash, khác input khác hash.
 *   D. GET /api/observation/timeline (gọi handler trực tiếp — pattern r92-C):
 *      shape pin (ok/flags/events/hasMore/nextBefore/total/traces/kinds) ·
 *      newest-first (seq desc) · filter kind/actor/runId · paginate before ·
 *      hasMore + nextBefore đúng · join traces CHỈ khi có runId (C.4) ·
 *      400 rác (limit 0/âm/ky tự, before âm, since rác) — contract 15-a.
 *   E. READ-ONLY TUYỆT ĐỐI: count 3 bảng (ObservationEvent/BrainInferenceTrace/
 *      TuningParam) trước/sau chuỗi GET GIỐNG HỆT (r86 precedent).
 *   F. Cờ off (env xóa + STORE dọn) → GET vẫn 200 ok, flags.obsLedger=false
 *      (timeline đọc những gì có — không phụ thuộc cờ).
 *   G. Prune vết 20K/14 ngày (FB-OBS-R1-06): age (ts cũ) + count-cap qua opts
 *      keep; guard chống prune chồng chéo (FB-OBS-R1-13 — source-scan).
 *
 * DB CÔ LẬP qua preload — cleanup afterAll theo pattern r92.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import {
  traceInference, flushTraceQueue, hashObsInput, capTraceJson,
  pruneBrainInferenceTraces,
  OBS_TRACE_JSON_MAX_BYTES, OBS_TRACE_KEEP, OBS_TRACE_MAX_AGE_DAYS,
} from '@/lib/observation/trace'
import { observeEvent, flushObservationQueue } from '@/lib/observation/ledger'
import { GET } from '@/app/api/observation/timeline/route'
import { resetTuningValue, refreshTuningSnapshot } from '@/lib/learning/tuning-store'

const call = (q: string) => GET(new Request(`http://t/api/observation/timeline${q}`))

const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

beforeAll(async () => {
  process.env.OBS_LEDGER = 'on' // ENV layer — STORE›ENV›DEFAULT
  delete process.env.OBS_BRAIN_TRACE
  delete process.env.UI_OBSERVATION
  delete process.env.OBS_IMPACT
  await db.tuningParam.deleteMany({
    where: { key: { in: ['obs_ledger', 'obs_brain_trace', 'obs_impact', 'ui_observation'] } },
  })
  await refreshTuningSnapshot()
  await db.observationEvent.deleteMany({})
  await db.brainInferenceTrace.deleteMany({})
})

afterAll(async () => {
  delete process.env.OBS_LEDGER
  delete process.env.OBS_BRAIN_TRACE
  delete process.env.OBS_IMPACT
  delete process.env.UI_OBSERVATION
  for (const k of ['obs_ledger', 'obs_brain_trace', 'obs_impact', 'ui_observation']) {
    try { await resetTuningValue(k) } catch { /* chưa set — bỏ */ }
  }
  await refreshTuningSnapshot()
  await db.observationEvent.deleteMany({})
  await db.brainInferenceTrace.deleteMany({})
})

// ==================== A. Hash-only (mặc định — Q2 §7) ====================

describe('r96 · A — traceInference hash-only', () => {
  test('A1 row trace + inputHash 64-hex + ref event trỏ đúng', async () => {
    const n0 = await db.brainInferenceTrace.count()
    traceInference({
      brain: 'surrogate', organ: 'replay_eval', modelVersion: 3,
      input: { model: 'gpt-x', agent: 'opus', delegated: false },
      output: { success: 0.42, tokens: 1200, durationMs: 8000 },
      latencyMs: 7, runId: 'run_a1',
    })
    await flushTraceQueue()
    await flushObservationQueue()
    const rows = await db.brainInferenceTrace.findMany({ orderBy: { ts: 'desc' } })
    expect(rows.length).toBe(n0 + 1)
    const t = rows[0]
    expect(t.brain).toBe('surrogate')
    expect(t.organ).toBe('replay_eval')
    expect(t.modelVersion).toBe(3)
    expect(t.runId).toBe('run_a1')
    expect(t.latencyMs).toBe(7)
    expect(t.inputHash).toBe(hashObsInput({ model: 'gpt-x', agent: 'opus', delegated: false }))
    expect(t.inputHash).toMatch(/^[0-9a-f]{64}$/) // SHA-256 hex
    // hash-only: KHÔNG lưu vector (Q2 §7 chốt)
    expect(t.inputJson).toBeNull()
    expect(t.outputJson).toBeNull()
    // ref event trong ledger — timeline 1 nguồn duy nhất (C.4)
    const ref = await db.observationEvent.findFirst({ where: { kind: 'brain.infer-ref', rowKey: t.id } })
    expect(ref).toBeDefined()
    expect(ref?.table).toBe('BrainInferenceTrace')
    expect(ref?.actor).toBe('brain:surrogate')
    expect(ref?.runId).toBe('run_a1')
  })
})

// ==================== B. Full vector khi obs_brain_trace on ====================

describe('r96 · B — cờ obs_brain_trace nâng full vector', () => {
  beforeAll(() => {
    process.env.OBS_BRAIN_TRACE = 'on'
  })
  afterAll(() => {
    delete process.env.OBS_BRAIN_TRACE
  })

  test('B1 inputJson/outputJson đầy đủ; vector lớn → cap 2KB truncated', async () => {
    const n0 = await db.brainInferenceTrace.count()
    traceInference({
      brain: 'policy', organ: 'policy_mixture', modelVersion: 2,
      input: [0.1, 0.2, 0.3], output: [0.25, 0.75],
      latencyMs: 3, runId: 'run_b1',
    })
    traceInference({
      brain: 'policy', organ: 'policy_mixture', modelVersion: 2,
      input: new Array(2000).fill(0.123456789), output: [1],
      latencyMs: 4, runId: 'run_b1',
    })
    await flushTraceQueue()
    const rows = await db.brainInferenceTrace.findMany({ orderBy: { ts: 'desc' } })
    expect(rows.length).toBe(n0 + 2)
    const small = rows.find(r => r.inputJson !== null && r.inputJson!.length < 100)
    expect(small?.inputJson).toBe('[0.1,0.2,0.3]')
    expect(small?.outputJson).toBe('[0.25,0.75]')
    const big = rows.find(r => r.inputJson !== null && r.inputJson!.length > 100)
    expect(big?.inputJson!.length).toBeLessThanOrEqual(OBS_TRACE_JSON_MAX_BYTES)
    expect(big?.inputJson).toContain('"truncated":true')
    expect(OBS_TRACE_JSON_MAX_BYTES).toBe(2048) // pin §C.2
  })

  test('B2 đa byte — cap theo BYTE UTF-8, không theo .length (FB-OBS-R1-03)', () => {
    // 1.502 ký tự (≈4.506 byte UTF-8) — qua cap cũ .length nhưng vượt 2KB thật
    // (code cũ giữ nguyên → vector ~2.2× vượt cap)
    const v = 'ụ'.repeat(1_500)
    const json = JSON.stringify(v)
    expect(json.length).toBeLessThanOrEqual(OBS_TRACE_JSON_MAX_BYTES) // .length lừa cap cũ
    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(OBS_TRACE_JSON_MAX_BYTES) // byte thật
    const out = capTraceJson(v)
    expect(out).toContain('"truncated":true')
    expect(Buffer.byteLength(out!, 'utf8')).toBeLessThanOrEqual(OBS_TRACE_JSON_MAX_BYTES) // sau fix đúng 2KB
    const parsed = JSON.parse(out!) as { truncated: boolean; head: string }
    expect(parsed.truncated).toBe(true)
    expect(parsed.head.length).toBeGreaterThan(500) // cắt thô vẫn giữ nội dung đáng kể
  })
})

// ==================== C. Hash tất định ====================

describe('r96 · C — hashObsInput tất định', () => {
  test('C1 cùng input → cùng hash; khác input → khác hash', () => {
    expect(hashObsInput([1, 2, 3])).toBe(hashObsInput([1, 2, 3]))
    expect(hashObsInput([1, 2, 3])).not.toBe(hashObsInput([1, 2, 4]))
    expect(hashObsInput(null)).toBe(hashObsInput(null))
    expect(capTraceJson(null)).toBeNull()
    expect(capTraceJson(undefined)).toBeNull()
  })
})

// ==================== D. GET timeline — shape + filter + paginate ====================

describe('r96 · D — GET /api/observation/timeline', () => {
  beforeAll(async () => {
    // Seed sạch: 5 sự kiện đa dạng + 2 trace cùng runId 'run_d'
    await db.observationEvent.deleteMany({})
    await db.brainInferenceTrace.deleteMany({})
    observeEvent({ actor: 'agent:opus', kind: 'run.start', runId: 'run_d', summary: 'bắt đầu run_d' })
    observeEvent({ actor: 'system', kind: 'qentry.add', runId: 'run_d', table: 'QEntry', summary: 'Q ghi' })
    observeEvent({ actor: 'user', kind: 'tuning.change', summary: 'đổi alpha' })
    observeEvent({ actor: 'agent:opus', kind: 'run.end', runId: 'run_d', summary: 'kết thúc run_d' })
    observeEvent({ actor: 'system', kind: 'flag.flip', summary: 'bật cờ' })
    await flushObservationQueue()
    traceInference({ brain: 'surrogate', organ: 'replay_eval', modelVersion: 1, input: [1], output: [0.5], latencyMs: 2, runId: 'run_d' })
    traceInference({ brain: 'policy', organ: 'policy_mixture', modelVersion: 1, input: [2], output: [0.9], latencyMs: 3, runId: 'run_d' })
    await flushTraceQueue()
    await flushObservationQueue()
  })

  test('D1 không filter — shape đầy đủ + newest-first', async () => {
    const res = await call('')
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      ok: boolean
      flags: Record<string, boolean>
      events: Array<{ seq: number; kind: string; actor: string; summary: string; payload: Record<string, unknown>; ts: string }>
      hasMore: boolean
      nextBefore: number | null
      total: number
      traces: unknown[]
      kinds: Array<{ kind: string }>
    }
    expect(json.ok).toBe(true)
    expect(json.flags.obsLedger).toBe(true) // env on
    expect(json.flags.uiObservation).toBe(false) // default off
    // 5 seed + 2 brain.infer-ref (từ 2 trace) = 7
    expect(json.total).toBe(7)
    expect(json.events.length).toBe(7)
    expect(json.hasMore).toBe(false)
    expect(json.nextBefore).toBeNull()
    // newest-first: seq giảm dần
    for (let i = 1; i < json.events.length; i++) {
      expect(json.events[i].seq).toBeLessThan(json.events[i - 1].seq)
    }
    // traces CHỈ join khi có runId (C.4) — không filter → rỗng
    expect(json.traces).toEqual([])
    // kinds catalog single-source (kinds.ts — 16 kind)
    expect(json.kinds.length).toBe(16)
  })

  test('D2 filter kind + actor', async () => {
    const r1 = (await (await call('?kind=tuning.change')).json()) as { events: Array<{ kind: string }> }
    expect(r1.events.length).toBe(1)
    expect(r1.events[0].kind).toBe('tuning.change')
    const r2 = (await (await call('?actor=agent%3Aopus')).json()) as { events: Array<{ actor: string }> }
    expect(r2.events.length).toBe(2)
    expect(r2.events.every(e => e.actor === 'agent:opus')).toBe(true)
  })

  test('D3 kim tuyến runId — events lọc + traces JOIN (C.4 cả 2 nguồn 1 response)', async () => {
    const json = (await (await call('?runId=run_d')).json()) as {
      events: Array<{ runId: string | null; kind: string }>
      traces: Array<{ brain: string; organ: string | null; inputHash: string; latencyMs: number; runId: string | null }>
      total: number
    }
    // 5 = run.start + qentry.add + run.end (seed) + 2 brain.infer-ref (từ 2 trace)
    expect(json.events.length).toBe(5)
    expect(json.events.every(e => e.runId === 'run_d')).toBe(true)
    expect(json.traces.length).toBe(2)
    expect(json.traces.every(t => t.runId === 'run_d')).toBe(true)
    const organs = json.traces.map(t => t.organ).sort()
    expect(organs).toEqual(['policy_mixture', 'replay_eval'])
  })

  test('D4 paginate before + limit → hasMore + nextBefore đúng', async () => {
    const all = (await (await call('')).json()) as { events: Array<{ seq: number }> }
    const seqs = all.events.map(e => e.seq).sort((a, b) => b - a) // desc
    // lấy 3 mới nhất
    const p1 = (await (await call('?limit=3')).json()) as { events: Array<{ seq: number }>; hasMore: boolean; nextBefore: number | null; total: number }
    expect(p1.events.length).toBe(3)
    expect(p1.hasMore).toBe(true)
    expect(p1.total).toBe(7)
    expect(p1.events[0].seq).toBe(seqs[0])
    expect(p1.nextBefore).toBe(seqs[2])
    // trang 2
    const p2 = (await (await call(`?limit=3&before=${seqs[2]}`)).json()) as { events: Array<{ seq: number }>; hasMore: boolean }
    expect(p2.events.length).toBe(3)
    expect(p2.events[0].seq).toBe(seqs[3])
    // hết
    const p3 = (await (await call(`?limit=50&before=${seqs[5]}`)).json()) as { events: unknown[]; hasMore: boolean }
    expect(p3.events.length).toBe(1)
    expect(p3.hasMore).toBe(false)
  })

  test('D5 tham số rác → 400 (contract 15-a precedent)', async () => {
    expect((await call('?limit=0')).status).toBe(400)
    expect((await call('?limit=-5')).status).toBe(400)
    expect((await call('?limit=abc')).status).toBe(400)
    expect((await call('?limit=201')).status).toBe(400) // trần MAX 200
    expect((await call('?before=0')).status).toBe(400)
    expect((await call('?before=-1')).status).toBe(400)
    expect((await call('?since=khong-phai-iso')).status).toBe(400)
    expect((await call('?since=2026-10-13T00:00:00Z')).status).toBe(200) // ISO hợp lệ
  })

  test('D6 since lọc đúng — sự kiện cũ hơn bị loại', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString()
    const json = (await (await call(`?since=${encodeURIComponent(future)}`)).json()) as { events: unknown[]; total: number }
    expect(json.events.length).toBe(0)
    expect(json.total).toBe(0)
  })
})

// ==================== E. READ-ONLY pin (r86 precedent) ====================

describe('r96 · E — READ-ONLY TUYỆT ĐỐI (C.4)', () => {
  test('E1 chuỗi GET không đổi count 3 bảng', async () => {
    const snap = {
      obs: await db.observationEvent.count(),
      trace: await db.brainInferenceTrace.count(),
      tuning: await db.tuningParam.count(),
    }
    for (const q of ['', '?kind=run.start', '?runId=run_d', '?limit=1', '?actor=user', '?since=2020-01-01T00:00:00Z']) {
      await call(q)
    }
    expect(await db.observationEvent.count()).toBe(snap.obs)
    expect(await db.brainInferenceTrace.count()).toBe(snap.trace)
    expect(await db.tuningParam.count()).toBe(snap.tuning)
  })
})

// ==================== F. Cờ off → GET vẫn ok (đọc những gì có) ====================

describe('r96 · F — cờ off: response vẫn ok + flags phản ánh đúng', () => {
  beforeAll(() => {
    delete process.env.OBS_LEDGER
  })
  afterAll(() => {
    process.env.OBS_LEDGER = 'on' // trả lại cho các describe khác (nếu chạy xen kẽ)
  })

  test('F1 obsLedger=false + dữ liệu cũ vẫn đọc được', async () => {
    const res = await call('')
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; flags: { obsLedger: boolean }; events: unknown[] }
    expect(json.ok).toBe(true)
    expect(json.flags.obsLedger).toBe(false)
    expect(json.events.length).toBeGreaterThan(0) // lịch sử có trước vẫn hiển thị
  })
})

// ==================== G. Prune vết 20K/14 ngày (FB-OBS-R1-06/R1-13) ====================

describe('r96 · G — pruneBrainInferenceTraces (Q3 §7)', () => {
  beforeAll(() => {
    process.env.OBS_LEDGER = 'on' // trả lại từ F — G cần cờ on để seed qua traceInference?
  })

  test('G1 age: vết ts > 14 ngày bị xoá, vết mới giữ (seed thẳng DB)', async () => {
    await db.brainInferenceTrace.deleteMany({})
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000)
    for (let i = 1; i <= 3; i++) {
      await db.brainInferenceTrace.create({
        data: {
          brain: 'surrogate', organ: 'replay_eval', modelVersion: 1,
          inputHash: `deadbeef${i}`.padEnd(64, '0'), inputJson: null, outputJson: null,
          latencyMs: 1, ts: old, createdAt: old,
        },
      })
    }
    traceInference({ brain: 'policy', organ: 'policy_mixture', modelVersion: 1, input: [1], output: [0.5], latencyMs: 2 })
    await flushTraceQueue()
    expect(await db.brainInferenceTrace.count()).toBe(4)
    const res = await pruneBrainInferenceTraces()
    expect(res.deleted).toBe(3)
    const remain = await db.brainInferenceTrace.findMany()
    expect(remain.length).toBe(1)
    expect(remain[0].brain).toBe('policy')
  })

  test('G2 count-cap: giữ đúng N vết mới nhất theo createdAt (opts keep — FB-OBS-R1-06)', async () => {
    await db.brainInferenceTrace.deleteMany({})
    // seed thẳng DB 8 vết createdAt cách nhau 1 phút — ordering tất định
    for (let i = 1; i <= 8; i++) {
      await db.brainInferenceTrace.create({
        data: {
          brain: 'surrogate', organ: 'replay_eval', modelVersion: 1,
          inputHash: `cap${i}`.padEnd(64, '0'), inputJson: null, outputJson: null,
          latencyMs: 1, createdAt: new Date(Date.now() - i * 60_000),
        },
      })
    }
    const res = await pruneBrainInferenceTraces({ keep: 5 })
    expect(res.deleted).toBe(3) // 8 − 5 vết cũ nhất theo createdAt
    const remain = await db.brainInferenceTrace.findMany({ orderBy: { createdAt: 'asc' } })
    expect(remain.length).toBe(5)
    // mới nhất sống sót: createdAt cao nhất = vết 1 (i=1 → now−1 phút)
    expect(remain.map(r => r.inputHash.slice(0, 4))).toEqual(['cap5', 'cap4', 'cap3', 'cap2', 'cap1'])
    expect(await db.brainInferenceTrace.findFirst({ where: { inputHash: { startsWith: 'cap8' } } })).toBeNull()
    expect(OBS_TRACE_KEEP).toBe(20_000) // pin hằng số — production gọi không opts
    expect(OBS_TRACE_MAX_AGE_DAYS).toBe(14)
  })

  test('G3 drainTrace có pruning guard đối xứng ledger (FB-OBS-R1-13 — source-scan)', () => {
    const src = readSrc('src/lib/observation/trace.ts')
    expect(src).toContain('!st.pruning')
    expect(src).toContain('st.pruning = true')
    expect(src).toContain("state().pruning = false")
  })
})
