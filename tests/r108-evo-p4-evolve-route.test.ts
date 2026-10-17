/**
 * r108 — EVO-P4 (BLUEPRINT-EVO-NAO-P1-P5 §4.5/§5.7 — R24-c) — EVOLVE RUNNER + ROUTE
 * ============================================================================
 *
 * Contract pin §5.7 (F6/0.5): POST 400 reason = 'flag_off' | 'already_running'
 * | 'invalid_brain' (kể cả 'knowledge' ghost — chưa vào search space §8.4) |
 * 'invalid_candidates' (ngoài 4–24 bước 4) | 'invalid_seed' (additive — seed
 * người dùng phải nguyên 0..SEED_MAX). E2E thật: bật cờ qua ENV → POST chạy
 * vòng 4 ứng viên NHỎ trên fixture thật (calibration_v3 n=4) → poll tới done
 * → GET shape đúng → DB rows đủ (BrainSearchRun + 4 BrainSearchCandidate) →
 * cancel idempotent → dọn row của test (H5 additive — chỉ xóa data test tự tạo).
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { validateEvoStart, seedFromRunId, startEvoRun, getEvoRunState, cancelEvoRun } from '../src/lib/brain/evolve'
import { SEED_MAX, SEARCH_MAX_CANDIDATES } from '../src/lib/brain/search-space'
import { db } from '../src/lib/db'
import { resetTuningValue } from '../src/lib/learning/tuning-store'
import { POST as evolvePost, GET as evolveGet } from '../src/app/api/brain/evolve/route'

// ==================== VALIDATION (reason pin) ====================

describe('r108 · EVO-P4 validateEvoStart — reason pin §5.7', () => {
  test('A invalid_brain: ngoài A/B/C — kể cả knowledge ghost (§8.4)', () => {
    for (const bad of ['knowledge', 'foo', '', undefined, null, 42]) {
      const r = validateEvoStart({ brain: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('invalid_brain')
    }
  })

  test('B invalid_candidates: ngoài 4–24 bước 4 (H3) — null/undefined = mặc định 8 (lenient)', () => {
    for (const bad of [3, 5, 25, 0, -4, 4.5, '8']) {
      const r = validateEvoStart({ brain: 'policy', candidates: bad })
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('invalid_candidates')
    }
    // null/undefined → default 8 (hợp lệ)
    expect(validateEvoStart({ brain: 'policy', candidates: undefined }).ok).toBe(true)
    expect(validateEvoStart({ brain: 'policy', candidates: null }).ok).toBe(true)
    expect(SEARCH_MAX_CANDIDATES).toBe(24)
  })

  test('C invalid_seed: ngoài [0..SEED_MAX]', () => {
    expect(validateEvoStart({ brain: 'policy', seed: -1 }).reason).toBe('invalid_seed')
    expect(validateEvoStart({ brain: 'policy', seed: 1.5 }).reason).toBe('invalid_seed')
    expect(validateEvoStart({ brain: 'policy', seed: SEED_MAX + 1 }).reason).toBe('invalid_seed')
    // hợp lệ
    expect(validateEvoStart({ brain: 'policy', seed: 0 }).ok).toBe(true)
    expect(validateEvoStart({ brain: 'policy', seed: SEED_MAX }).ok).toBe(true)
  })

  test('D hợp lệ đầy đủ: brain + candidates mặc định 8 + seed tùy chọn', () => {
    expect(validateEvoStart({ brain: 'calibration_v3' }).ok).toBe(true)
    expect(validateEvoStart({ brain: 'surrogate', candidates: 4 }).ok).toBe(true)
    expect(validateEvoStart({ brain: 'policy', candidates: 24, seed: 123 }).ok).toBe(true)
  })

  test('E seedFromRunId tất định + trong biên (F7: hash(runId))', () => {
    expect(seedFromRunId('abc')).toBe(seedFromRunId('abc'))
    expect(seedFromRunId('abc')).not.toBe(seedFromRunId('abd'))
    expect(seedFromRunId('x')).toBeGreaterThanOrEqual(0)
    expect(seedFromRunId('x')).toBeLessThanOrEqual(SEED_MAX)
  })
})

// ==================== ROUTE — flag gate ====================

function makePost(body: unknown): Request {
  return new Request('http://localhost/api/brain/evolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('r108 · EVO-P4 route — cờ brain_evolve mặc định OFF (§5.7 flag_off)', () => {
  test('F POST khi cờ off → 400 flag_off (fail-open: xóa ENV + store trống)', async () => {
    delete process.env.BRAIN_EVOLVE
    const res = await evolvePost(makePost({ brain: 'policy', candidates: 4 }) as never)
    expect(res.status).toBe(400)
    const json = (await res.json()) as { ok: boolean; reason: string }
    expect(json.ok).toBe(false)
    expect(json.reason).toBe('flag_off')
  })
})

// ==================== E2E NHỎ (ENV bật cờ — STORE > ENV > DEFAULT) ====================

const E2E_RUN_IDS: string[] = []

describe('r108 · EVO-P4 E2E — vòng 4 ứng viên trên fixture thật (cờ on qua ENV)', () => {
  test('G POST hợp lệ → { ok, runId } → poll tới done → ứng viên + summary + DB rows', async () => {
    // STORE > ENV — xóa giá trị STORE có thể tồn tại (vd bản verify live để
    // 'off') để ENV test có hiệu lực; reset ghi audit đúng quy trình
    await resetTuningValue('brain_evolve').catch(() => {})
    process.env.BRAIN_EVOLVE = 'on'
    try {
      const res = await evolvePost(makePost({ brain: 'calibration_v3', candidates: 4, seed: 42 }) as never)
      expect(res.status).toBe(200)
      const json = (await res.json()) as { ok: boolean; runId: string }
      expect(json.ok).toBe(true)
      expect(typeof json.runId).toBe('string')
      E2E_RUN_IDS.push(json.runId)

      // Poll tới khi xong (fixture n=4 → mỗi ứng viên < 3s; timeout 120s)
      const deadline = Date.now() + 120_000
      let state: import('../src/lib/brain/evolve').EvolveGetResponse | null = null
      while (Date.now() < deadline) {
        state = await getEvoRunState('calibration_v3', json.runId)
        if (state.run && state.run.status !== 'running') break
        await new Promise(r => setTimeout(r, 1000))
      }
      expect(state?.run).not.toBeNull()
      expect(['done', 'cancelled', 'failed']).toContain(state!.run!.status)
      expect(state!.run!.status).toBe('done')
      expect(state!.run!.seed).toBe(42)
      expect(state!.run!.candidatesMax).toBe(4)
      expect(state!.candidates.length).toBe(4)
      // mỗi ứng viên: shape contract §5.7
      for (const c of state!.candidates) {
        expect(c.encoding.length).toBe(144)
        expect(Number.isFinite(c.cvScore)).toBe(true)
        expect(typeof c.archSummary).toBe('string')
        expect(c.archSummary.length).toBeGreaterThan(0)
        expect(typeof c.beatActive).toBe('boolean')
        expect(typeof c.blockedH7).toBe('boolean')
        expect(c.idx).toBeGreaterThanOrEqual(0)
        expect(c.idx).toBeLessThan(4)
      }
      expect(state!.run!.summary).toBeDefined()
      expect(state!.run!.summary!.durationMs).toBeGreaterThanOrEqual(0)
      // idx unique 0..3
      expect(new Set(state!.candidates.map(c => c.idx)).size).toBe(4)

      // DB rows (H5 additive — persist thật)
      const runRow = await db.brainSearchRun.findUnique({ where: { id: json.runId } })
      expect(runRow).not.toBeNull()
      expect(runRow!.status).toBe('done')
      expect(runRow!.inputMode).toBe('evo-144')
      expect(runRow!.dataFingerprint).toContain('evo-fixture:')
      const candRows = await db.brainSearchCandidate.findMany({ where: { runId: json.runId } })
      expect(candRows.length).toBe(4)
      for (const row of candRows) {
        expect((JSON.parse(row.encodingJson) as number[]).length).toBe(144)
        expect(Number.isFinite(row.cvScore)).toBe(true)
      }
    } finally {
      delete process.env.BRAIN_EVOLVE
    }
  }, 180_000)

  test('H GET qua route handler — shape response §5.7', async () => {
    const req = new Request('http://localhost/api/brain/evolve?brain=calibration_v3')
    const res = await evolveGet(req as never)
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; run: unknown; candidates: unknown[] }
    expect(json.ok).toBe(true)
    expect('run' in json).toBe(true)
    expect(Array.isArray(json.candidates)).toBe(true)
    // GET thiếu brain → 400
    const bad = await evolveGet(new Request('http://localhost/api/brain/evolve') as never)
    expect(bad.status).toBe(400)
  })

  test('I POST thứ hai sau khi vòng đầu xong → chạy được + POLL TỚI XONG (không kẹt already_running, không bỏ loop nền giữ lock DB)', async () => {
    await resetTuningValue('brain_evolve').catch(() => {})
    process.env.BRAIN_EVOLVE = 'on'
    try {
      const res = await evolvePost(makePost({ brain: 'calibration_v3', candidates: 4, seed: 43 }) as never)
      expect(res.status).toBe(200)
      const json = (await res.json()) as { ok: boolean; runId?: string; reason?: string }
      expect(json.ok).toBe(true)
      if (json.runId) {
        E2E_RUN_IDS.push(json.runId)
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
          const st = await getEvoRunState('calibration_v3', json.runId)
          if (st.run && st.run.status !== 'running') break
          await new Promise(r => setTimeout(r, 1000))
        }
      }
    } finally {
      delete process.env.BRAIN_EVOLVE
    }
  }, 150_000)

  test('J cancel idempotent — runId lạ vẫn 200 ok', async () => {
    const r1 = await cancelEvoRun('nonexistent_run')
    expect(r1.ok).toBe(true)
    // cancel run thật vừa chạy (đã done) → vẫn ok no-op
    if (E2E_RUN_IDS.length > 0) {
      const r2 = await cancelEvoRun(E2E_RUN_IDS[0]!)
      expect(r2.ok).toBe(true)
    }
  })
})

// ==================== DỌN DẸP (chỉ data test tự tạo — H5 additive) ====================

afterAll(async () => {
  for (const runId of E2E_RUN_IDS) {
    try {
      await db.brainSearchCandidate.deleteMany({ where: { runId } })
      await db.brainSearchRun.deleteMany({ where: { id: runId } })
    } catch {
      // fail-open — rows là data test additive, không chặn kết quả
    }
  }
})
