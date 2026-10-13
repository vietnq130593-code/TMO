/**
 * ROUND-95 TESTS — OBS-P1 · OBSERVATION LEDGER CORE
 * (BLUEPRINT-OBSERVATION-P1-P4 §C.2/C.3 — chốt §7 Task 23 2026-10-13)
 *
 * Đo lường:
 *   A. Cờ off → observeEvent NO-OP tuyệt đối (count bảng không đổi — C.3
 *      "overhead 0 khi off") + isObsLedgerEnabled false.
 *   B. Cờ on (ENV OBS_LEDGER=on — chuỗi STORE›ENV›DEFAULT) → ghi đúng
 *      actor/kind/summary/runId; seq đơn điệu tăng strict (RO-4 single-writer).
 *   C. capPayload ≤ 4KB: payload thường nguyên vẹn; payload 5KB → truncate +
 *      flag truncated:true; capPayload({}) = '{}'; C4 đa byte — cap theo BYTE
 *      UTF-8 không theo .length (FB-OBS-R1-03).
 *   D. Queue có-hạn 512: đẩy 600 sự kiện ĐỒNG BỘ (drain treo ở await đầu —
 *      không kịp tiêu) → dropped = 600 − 513 = 87 đúng công thức, written
 *      tăng đúng 513 (1 shifted + 512 queued).
 *   E. Prune 50K/30 ngày: dòng ts 40 ngày trước (seed thẳng DB, seq cao độc
 *      nhất) bị xoá; dòng mới giữ nguyên; E2 count-cap qua opts keep (FB-OBS-R1-06).
 *   F. Hook tuning (writeChangeLog): setTuningValue số → kind tuning.change;
 *      setTuningValue cờ off/on → kind flag.flip (payload from/to đúng).
 *   G. Hook run (agent-run-tracker): startAgentRun → run.start + endAgentRun
 *      → run.end, cùng runId + sessionId (kim tuyến GAP-1).
 *   H. Source-scan wiring (r92-E precedent): reward.log (GAP-4) + 3 pipeline
 *      observeBrainTrain + qentry.add + verdict.add + learn.episode + auto-learn
 *      db.write + 4 cờ TUNING_SPECS (26–29) + cờ thứ 30 obs_alerts (26-BE).
 *   I. verdict.add nhánh DELEGATE có rowKey trỏ dòng ArbiterVerdict thật (FB-OBS-R1-08).
 *
 * DB CÔ LẬP qua preload (tests/db-isolation-preload.ts) — không đụng
 * db/custom.db của app. Cleanup afterAll: xóa env + TuningParam 4 cờ obs +
 * refresh snapshot (không rò state sang file khác — pattern r92).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@/lib/db'
import {
  observeEvent, flushObservationQueue, getObservationHealth, isObsLedgerEnabled,
  capPayload, pruneObservationEvents,
  OBS_QUEUE_MAX, OBS_PAYLOAD_MAX_BYTES, OBS_EVENTS_MAX_AGE_DAYS,
} from '@/lib/observation/ledger'
import { OBS_KINDS } from '@/lib/observation/kinds'
import { setTuningValue, resetTuningValue, refreshTuningSnapshot } from '@/lib/learning/tuning-store'
import { TUNING_SPECS, getTuningSpec } from '@/lib/learning/neural-types'
import { startAgentRun, endAgentRun } from '@/lib/agent-run-tracker'
import { insertArbiterVerdict } from '@/lib/metrics-db'

const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8')

const OBS_FLAG_KEYS = ['obs_ledger', 'obs_brain_trace', 'obs_impact', 'ui_observation', 'obs_alerts'] as const

async function wipeObsTables(): Promise<void> {
  await db.observationEvent.deleteMany({})
  await db.brainInferenceTrace.deleteMany({})
}

/** Hook đợt 1 dùng dynamic import (chống chu trình) — cho import resolve +
 *  queue populate RỒI mới flush (fire-and-forget là thiết kế C.3, test cần settle). */
async function settleAndFlush(): Promise<void> {
  await new Promise(r => setTimeout(r, 40))
  await flushObservationQueue()
  await new Promise(r => setTimeout(r, 10))
  await flushObservationQueue()
}

beforeAll(async () => {
  delete process.env.OBS_LEDGER
  delete process.env.OBS_BRAIN_TRACE
  delete process.env.OBS_IMPACT
  delete process.env.UI_OBSERVATION
  delete process.env.OBS_ALERTS
  await db.tuningParam.deleteMany({ where: { key: { in: [...OBS_FLAG_KEYS] } } })
  await refreshTuningSnapshot()
  await wipeObsTables()
})

afterAll(async () => {
  delete process.env.OBS_LEDGER
  delete process.env.OBS_BRAIN_TRACE
  delete process.env.OBS_IMPACT
  delete process.env.UI_OBSERVATION
  delete process.env.OBS_ALERTS
  // chờ hook straggler (dynamic import) no-op hoá + drain hết queue đang chạy
  // — tránh deleteMany đụng lock SQLite với transaction drain (timeout 5s)
  await settleAndFlush()
  for (const k of ['q_learning_alpha', ...OBS_FLAG_KEYS]) {
    try { await resetTuningValue(k) } catch { /* chưa từng set — bỏ qua */ }
  }
  await refreshTuningSnapshot()
  await wipeObsTables()
})

// ==================== A. Cờ off → no-op (C.3 overhead 0) ====================

describe('r95 · A — cờ obs_ledger off (mặc định): observeEvent no-op', () => {
  test('A1 isObsLedgerEnabled=false + observeEvent KHÔNG ghi dòng nào', async () => {
    expect(isObsLedgerEnabled()).toBe(false)
    const before = await db.observationEvent.count()
    observeEvent({ actor: 'system', kind: 'run.start', summary: 'không nên tồn tại' })
    observeEvent({ actor: 'user', kind: 'tuning.change', summary: 'cũng không' })
    await flushObservationQueue()
    const after = await db.observationEvent.count()
    expect(after).toBe(before) // 0 sự kiện — cờ chặn TẠI observeEvent (C.3)
  })

  test('A2 health counters không tăng khi off (queue không nhận)', async () => {
    const h0 = getObservationHealth()
    observeEvent({ actor: 'system', kind: 'obs.health', summary: 'off' })
    const h1 = getObservationHealth()
    expect(h1.written).toBe(h0.written)
    expect(h1.queued).toBe(h0.queued)
  })
})

// ==================== B. Cờ on → ghi đúng + seq đơn điệu ====================

describe('r95 · B — cờ on (ENV): ghi sự kiện đúng trường + seq đơn điệu', () => {
  beforeAll(() => {
    process.env.OBS_LEDGER = 'on'
  })

  test('B1 3 sự kiện → 3 dòng, seq strict tăng, đủ trường', async () => {
    await wipeObsTables()
    observeEvent({ actor: 'agent:opus', kind: 'run.start', runId: 'run_b1', sessionId: 'sess_b1', summary: 'opus bắt đầu', payload: { task: 'demo' } })
    observeEvent({ actor: 'system', kind: 'db.write', table: 'QEntry', rowKey: 's|a', summary: 'Q ghi', payload: { qValue: 0.5 } })
    observeEvent({ actor: 'brain:policy', kind: 'reward.log', summary: 'R=0.42', payload: { reward: 0.42 } })
    await flushObservationQueue()
    const rows = await db.observationEvent.findMany({ orderBy: { seq: 'asc' } })
    expect(rows.length).toBe(3)
    const seqs = rows.map(r => r.seq)
    expect(seqs[0]).toBeGreaterThan(0)
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]) // RO-4
    expect(rows[0].actor).toBe('agent:opus')
    expect(rows[0].kind).toBe('run.start')
    expect(rows[0].runId).toBe('run_b1')
    expect(rows[0].sessionId).toBe('sess_b1')
    expect(JSON.parse(rows[0].payloadJson)).toEqual({ task: 'demo' })
    expect(rows[1].table).toBe('QEntry')
    expect(rows[1].rowKey).toBe('s|a')
  })

  test('B2 payload undefined → "{}" (không phải "null"/"undefined")', async () => {
    await wipeObsTables()
    observeEvent({ actor: 'system', kind: 'db.write', summary: 'không payload' })
    await flushObservationQueue()
    const row = await db.observationEvent.findFirst()
    expect(row?.payloadJson).toBe('{}')
  })

  test('B3 isObsLedgerEnabled=true khi ENV on', () => {
    expect(isObsLedgerEnabled()).toBe(true)
  })
})

// ==================== C. capPayload ≤ 4KB (C.2/RO-2) ====================

describe('r95 · C — capPayload truncate 4KB', () => {
  test('C1 payload thường nguyên vẹn', () => {
    expect(capPayload({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}')
    expect(capPayload()).toBe('{}')
    expect(capPayload({})).toBe('{}')
  })

  test('C2 payload 5KB → truncate + flag truncated:true + độ dài ≤ 4KB', () => {
    const big = { blob: 'x'.repeat(5_000) }
    const out = capPayload(big)
    expect(out.length).toBeLessThanOrEqual(OBS_PAYLOAD_MAX_BYTES)
    expect(out).toContain('"truncated":true')
  })

  test('C3 OBS_PAYLOAD_MAX_BYTES = 4096 (pin §C.2)', () => {
    expect(OBS_PAYLOAD_MAX_BYTES).toBe(4096)
    expect(OBS_QUEUE_MAX).toBe(512) // C.3 "bounded queue 512"
    expect(OBS_EVENTS_MAX_AGE_DAYS).toBe(30) // Q3 §7 chốt
  })

  test('C4 đa byte — cap theo BYTE UTF-8, không theo .length (FB-OBS-R1-03)', () => {
    // 3.013 KÝ TỰ (≈9.039 byte UTF-8) — qua được cap cũ đếm .length nhưng
    // vượt 4KB thật theo byte (code cũ giữ nguyên → payload ~2.2× vượt cap)
    const mb = { blob: 'ụ'.repeat(3_000) }
    const json = JSON.stringify(mb)
    expect(json.length).toBeLessThanOrEqual(OBS_PAYLOAD_MAX_BYTES) // .length lừa cap cũ
    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(OBS_PAYLOAD_MAX_BYTES) // byte thật
    const out = capPayload(mb)
    expect(out).toContain('"truncated":true')
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(OBS_PAYLOAD_MAX_BYTES) // sau fix đúng 4KB
    const parsed = JSON.parse(out) as { truncated: boolean; head: string }
    expect(parsed.truncated).toBe(true)
    expect(parsed.head.length).toBeGreaterThan(1_000) // cắt thô vẫn giữ nội dung đáng kể
  })
})

// ==================== D. Queue có-hạn 512 — drop + đếm (C.3) ====================

describe('r95 · D — queue đầy → drop + đếm dropped (fail-open)', () => {
  test('D1 đẩy 600 đồng bộ → dropped 87 · written tăng 513', async () => {
    await wipeObsTables()
    const h0 = getObservationHealth()
    // Đẩy ĐỒNG BỘ không await: drain() treo ở await $transaction đầu tiên —
    // mọi push còn lại chỉ vào queue. Push 1 bị shift ngay (drain bắt đầu).
    for (let i = 0; i < 600; i++) {
      observeEvent({ actor: 'system', kind: 'db.write', summary: `burst ${i}` })
    }
    await flushObservationQueue()
    const h1 = getObservationHealth()
    // 600 = 1 (shift ngay) + 512 (queue đầy) + 87 (drop)
    expect(h1.dropped - h0.dropped).toBe(600 - 1 - OBS_QUEUE_MAX)
    expect(h1.written - h0.written).toBe(1 + OBS_QUEUE_MAX)
    const n = await db.observationEvent.count()
    expect(n).toBe(1 + OBS_QUEUE_MAX)
  })
})

// ==================== E. Prune 50K/30 ngày (Q3 §7) ====================

describe('r95 · E — prune theo tuổi', () => {
  test('E1 dòng > 30 ngày bị xoá, dòng mới giữ', async () => {
    await wipeObsTables()
    // seed thẳng DB 2 dòng cũ (ts 40 ngày trước) — seq cao độc nhất không đụng ledger
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000)
    await db.observationEvent.create({ data: { seq: 900_001, ts: old, actor: 'system', kind: 'db.write', summary: 'cũ 40 ngày', payloadJson: '{}' } })
    await db.observationEvent.create({ data: { seq: 900_002, ts: old, actor: 'system', kind: 'db.write', summary: 'cũ 40 ngày 2', payloadJson: '{}' } })
    observeEvent({ actor: 'system', kind: 'obs.health', summary: 'mới' })
    await flushObservationQueue()
    expect(await db.observationEvent.count()).toBe(3)
    const res = await pruneObservationEvents()
    expect(res.deleted).toBe(2)
    const remain = await db.observationEvent.findMany()
    expect(remain.length).toBe(1)
    expect(remain[0].summary).toBe('mới')
  })

  test('E2 count-cap giữ đúng N dòng mới nhất theo seq (FB-OBS-R1-06)', async () => {
    await wipeObsTables()
    // seed thẳng DB 8 dòng ts mới (không dính age-based) — opts keep=5
    // (production gọi không tham số — hằng số 50K không seed nổi trong test)
    for (let i = 1; i <= 8; i++) {
      await db.observationEvent.create({
        data: { seq: 901_000 + i, actor: 'system', kind: 'db.write', summary: `cap ${i}`, payloadJson: '{}' },
      })
    }
    const res = await pruneObservationEvents({ keep: 5 })
    expect(res.deleted).toBe(3) // 8 − 5 dòng cũ nhất theo seq
    const remain = await db.observationEvent.findMany({ orderBy: { seq: 'asc' } })
    expect(remain.length).toBe(5)
    expect(remain.map(r => r.seq)).toEqual([901_004, 901_005, 901_006, 901_007, 901_008])
    // thứ tự giữ là MỚI NHẤT — 901_008 (đúng nhất) sống sót, 901_001..003 bị xoá
    expect(await db.observationEvent.findFirst({ where: { seq: 901_001 } })).toBeNull()
    expect(await db.observationEvent.findFirst({ where: { seq: 901_008 } })).toBeDefined()
  })
})

// ==================== F. Hook tuning.change / flag.flip (đợt 1) ====================

describe('r95 · F — hook tuning-store writeChangeLog', () => {
  test('F1 set tham số SỐ → kind tuning.change (payload from/to)', async () => {
    await wipeObsTables()
    await setTuningValue('q_learning_alpha', 0.2)
    await settleAndFlush()
    const rows = await db.observationEvent.findMany({ orderBy: { seq: 'desc' }, take: 2 })
    const evt = rows.find(r => r.kind === 'tuning.change')
    expect(evt).toBeDefined()
    expect(evt?.actor).toBe('user')
    const p = JSON.parse(evt?.payloadJson ?? '{}')
    expect(p.key).toBe('q_learning_alpha')
    expect(p.action).toBe('set')
    expect(p.to).toBe('0.2')
  })

  test('F2 set CỜ off/on → kind flag.flip', async () => {
    await wipeObsTables()
    await setTuningValue('obs_brain_trace', 'on')
    await settleAndFlush()
    const evt = await db.observationEvent.findFirst({ where: { kind: 'flag.flip' } })
    expect(evt).toBeDefined()
    const p = JSON.parse(evt?.payloadJson ?? '{}')
    expect(p.key).toBe('obs_brain_trace')
    expect(p.to).toBe('on')
    await resetTuningValue('obs_brain_trace') // dọn STORE — flag.flip reset kế tiếp không cần assert
  })
})

// ==================== G. Hook run.start / run.end (đợt 1 — kim tuyến) ====================

describe('r95 · G — hook agent-run-tracker (kim tuyến runId)', () => {
  test('G1 start → run.start; end → run.end cùng runId', async () => {
    await wipeObsTables()
    const runId = startAgentRun({ sessionId: 'sess-obs-g1', agentName: 'tester-obs', task: 'kiểm thử quan sát' })
    expect(runId).toBeTypeOf('string')
    endAgentRun('sess-obs-g1', runId, 'done', 'xong sạch')
    await settleAndFlush()
    const events = await db.observationEvent.findMany({ orderBy: { seq: 'asc' } })
    const kinds = events.map(e => e.kind)
    expect(kinds).toContain('run.start')
    expect(kinds).toContain('run.end')
    for (const e of events) {
      if (e.kind === 'run.start' || e.kind === 'run.end') {
        expect(e.runId).toBe(runId)
        expect(e.sessionId).toBe('sess-obs-g1')
        expect(e.actor).toBe('agent:tester-obs')
      }
    }
    const end = events.find(e => e.kind === 'run.end')
    const p = JSON.parse(end?.payloadJson ?? '{}')
    expect(p.status).toBe('done')
    expect(p.success).toBe(true)
  })
})

// ==================== H. Source-scan wiring (r92-E precedent) ====================

describe('r95 · H — source-scan wiring đợt 1+2 (OBS-P1/P2 hooks)', () => {
  const smolab = readSrc('src/components/smolab/smolab-module.tsx')
  const brainTab = readSrc('src/components/smolab/brain-tab.tsx')

  test('H1 reward.ts — hook reward.log cạnh console.log (GAP-4, vẫn LOG-ONLY)', () => {
    const src = readSrc('src/lib/brain/reward.ts')
    expect(src).toContain("kind: 'reward.log'")
    expect(src).toContain("actor: 'brain:policy'")
    expect(src).toContain('console.log') // console.log GIỮ NGUYÊN — ledger chỉ GHI THÊM
    expect(src).toContain('logOnly: true') // pin trung thực LOG-ONLY (Q1 đợt quan sát 1)
  })

  test('H2 3 pipeline train — observeBrainTrain start/end (§C.3)', () => {
    for (const f of [
      'src/lib/brain/calibration-v3.ts',
      'src/lib/brain/brains/surrogate.ts',
      'src/lib/brain/brains/policy.ts',
    ]) {
      const src = readSrc(f)
      expect(src).toContain("observeBrainTrain(")
      expect(src).toContain("'start'")
      expect(src).toContain("'end'")
    }
  })

  test('H3 db.write hooks — qentry.add + verdict.add + learn.episode + auto-learn', () => {
    expect(readSrc('src/lib/learning/q-table.ts')).toContain("kind: 'qentry.add'")
    const mdb = readSrc('src/lib/metrics-db.ts')
    expect(mdb).toContain("kind: 'verdict.add'")
    expect(mdb.split("kind: 'verdict.add'").length).toBe(3) // 2 nhánh delegate+raw
    const epi = readSrc('src/lib/episodic-memory/episodic-db.ts')
    expect(epi).toContain("kind: 'learn.episode'")
    expect(epi.split("kind: 'learn.episode'").length).toBe(5) // 4 occurrence `kind:` (episode 2 nhánh + lesson 2 nhánh) → split 5 đoạn — FB-OBS-R1-10 sửa comment (không có "định nghĩa kinds" nào trong file)
    expect(readSrc('src/lib/auto-learn.ts')).toContain("kind: 'db.write'")
  })

  test('H4 organ inference hooks — calibrate + replay_eval + policy_mixture (đợt 2)', () => {
    expect(readSrc('src/lib/brain/calibration-v3.ts')).toContain("organ: 'calibrate'")
    expect(readSrc('src/lib/brain/brains/surrogate.ts')).toContain("organ: 'replay_eval'")
    expect(readSrc('src/lib/brain/brains/policy.ts')).toContain("organ: 'policy_mixture'")
  })

  test('H5 TUNING_SPECS đủ 5 cờ obs (26–30) đúng envKey/default/nodeId', () => {
    expect(TUNING_SPECS.length).toBe(30) // PIN UPDATE Task 26-BE: 29 → 30 (cờ obs_alerts GAP-2)
    for (const key of OBS_FLAG_KEYS) {
      const spec = getTuningSpec(key)
      expect(spec, key).toBeDefined()
      expect(spec?.type).toBe('enum')
      expect(spec?.enumValues).toEqual(['off', 'on'])
      expect(spec?.default).toBe('off') // cờ off mặc định — doctrine #8
      expect(spec?.nodeId).toBe('hist-feedback') // node Historical Feedback (learning layer) — r81 khớp 2 chiều
    }
    expect(getTuningSpec('obs_ledger')?.envKey).toBe('OBS_LEDGER')
    expect(getTuningSpec('ui_observation')?.envKey).toBe('UI_OBSERVATION')
    expect(getTuningSpec('obs_alerts')?.envKey).toBe('OBS_ALERTS') // 26-BE — cờ thứ 30
  })

  test('H6 kinds.ts — 17 kind chuẩn + obs.alert nhóm alert (Task 26-BE GAP-2) + kind HyperNAS search.* đặt trước (single-source §9 HyperNAS)', () => {
    expect(OBS_KINDS.length).toBe(17) // PIN UPDATE Task 26-BE: 16 → 17 (obs.alert)
    expect(OBS_KINDS.map(k => k.kind)).toContain('search.session')
    expect(OBS_KINDS.map(k => k.kind)).toContain('impact.estimate')
    expect(OBS_KINDS.map(k => k.kind)).toContain('brain.infer-ref')
    // 26-BE — cảnh báo quan sát (nhóm alert, chip amber — hợp đồng 26-RESTORE)
    const alertDef = OBS_KINDS.find(k => k.kind === 'obs.alert')
    expect(alertDef?.group).toBe('alert')
    expect(alertDef?.label).toBe('Cảnh báo quan sát')
  })

  test('H7 tab Quan sát đăng ký theo cấu trúc Task 26 — selector SECTION 1 + panel dưới đài (OBS-P3; PIN UPDATE 26-FE/26-BE)', () => {
    // Task 25: tab Quan sát từng là tab console thứ 5 SECTION 3. Task 26
    // (chỉ thị user 2026-10-13 — "tích hợp vào ô Chọn não… xem ngay dưới đài
    // quan sát"): 26-FE chuyển Quan sát LÊN selector "Chế độ quan sát" 4 nút
    // SECTION 1 + 4 panel mount/unmount theo obsMode NGAY DƯỚI đài SECTION 2,
    // bỏ tab console 'observation' (brain-tab.tsx 26-FE — r93 pin chi tiết).
    expect(brainTab).toContain("useState<ObsMode>('neurons')")
    expect(brainTab).toContain("obsMode === 'timeline'")
    expect(brainTab).toContain('<ObsTimelinePanel />')
    // SECTION 3 còn 4 tab console — KHÔNG còn 'observation'
    expect(brainTab).toContain('obsMode')
    expect(brainTab).not.toContain("'train' | 'tuning' | 'log' | 'ref' | 'observation'")
    // smolab-module: KHÔNG còn đăng ký tab riêng + localStorage cũ chuyển hướng 'brain'
    expect(smolab).not.toContain("{ id: 'observation'")
    expect(smolab).not.toContain("activeSmolabTab === 'observation'")
    expect(smolab).toContain("if (saved === 'observation')")
  })
})

// ==================== I. verdict.add delegate — rowKey kim tuyến (FB-OBS-R1-08) ====================

describe('r95 · I — hook verdict.add nhánh delegate có rowKey', () => {
  test('I1 insertArbiterVerdict (delegate path) → event rowKey = id dòng ArbiterVerdict thật', async () => {
    await wipeObsTables()
    await insertArbiterVerdict({
      sessionId: 'sess_obs_i1', cycle: 7, complete: true, confidence: 0.9, verified: true,
    })
    await settleAndFlush()
    const evt = await db.observationEvent.findFirst({ where: { kind: 'verdict.add' } })
    expect(evt).toBeDefined()
    expect(evt?.table).toBe('ArbiterVerdict')
    // FB-OBS-R1-08: trước đây nhánh delegate bỏ rowKey — event không trỏ về
    // dòng ArbiterVerdict cụ thể (mất kim tuyến cho phán quyết)
    expect(evt?.rowKey).toBeDefined()
    const row = await db.arbiterVerdict.findFirst({ where: { sessionId: 'sess_obs_i1' } })
    expect(row).toBeDefined()
    expect(evt?.rowKey).toBe(row!.id)
  })
})
