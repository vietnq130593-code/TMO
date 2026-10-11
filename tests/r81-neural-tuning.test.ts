/**
 * r81 — NEURAL-ARCH TAB (2026-10-11): tuning-store + graph spec + wiring pin
 * ============================================================================
 * Phủ 5 tầng:
 *   1. TUNING_SPECS/NEURAL_GRAPH integrity (thuần — unique key, min/max,
 *      default trong phạm vi, paramKeys ↔ nodeId khớp 2 chiều, edge trỏ node có thật)
 *   2. validateTuningInput (thuần — sai phạm vi/sai enum/key lạ bị chặn)
 *   3. Chuỗi hiệu lực STORE > ENV > DEFAULT (DB throwaway qua preload —
 *      các key dùng trong test đều reset trước khi assert default)
 *   4. WIRING PIN: updateQ đọc α/γ runtime (revert về hằng số → Q lệch →
 *      fail), ε-greedy episodic đọc runtime, stats-gate + matryoshka
 *      STORE đè ENV, near-dup threshold param hoá
 *   5. API route GET/POST trực tiếp (graph 6 lớp/23 node/14 tuning; set
 *      hợp lệ 200 + đổi state; giá trị rác 400; action lạ 400)
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import {
  TUNING_SPECS,
  NEURAL_GRAPH,
  NEURAL_NODES,
  NEURAL_EDGES,
  NEURAL_LAYERS,
  getTuningSpec,
} from '@/lib/learning/neural-types'
import {
  validateTuningInput,
  getTuningNumber,
  getTuningEnum,
  setTuningValue,
  resetTuningValue,
  getTuningState,
  resolveTuning,
  TuningValidationError,
} from '@/lib/learning/tuning-store'
import { updateQ, qLearningUpdate } from '@/lib/learning/q-table'
import { isAdaptationStatsGateBlocking } from '@/lib/learning/adaptation-stats'
import { isMatryoshkaPilotEnabled } from '@/lib/embeddings'
import { decideNearDuplicate } from '@/lib/ingestion/doc-dedup'
import { applyEpsilonExploration } from '@/lib/episodic-memory/preact'
import { db } from '@/lib/db'
import { GET, POST } from '@/app/api/neural-architecture/route'

// ==================== 1. SPEC + GRAPH INTEGRITY (thuần) ====================

describe('r81 · TUNING_SPECS integrity', () => {
  test('14 key duy nhất, mỗi key có spec (BRAIN-P2 +calibration_v3)', () => {
    const keys = TUNING_SPECS.map(s => s.key)
    expect(keys.length).toBe(14)
    expect(new Set(keys).size).toBe(14)
    for (const k of keys) expect(getTuningSpec(k)?.key).toBe(k)
    expect(getTuningSpec('khong-ton-tai')).toBeUndefined()
  })

  test('number spec: min < max, default trong [min,max], step > 0', () => {
    for (const s of TUNING_SPECS.filter(x => x.type === 'number')) {
      expect(s.min!).toBeLessThan(s.max!)
      expect(s.min!).toBeLessThanOrEqual(s.default as number)
      expect(s.default as number).toBeLessThanOrEqual(s.max!)
      expect(s.step!).toBeGreaterThan(0)
    }
  })

  test('enum spec: enumValues không rỗng, default hợp lệ', () => {
    for (const s of TUNING_SPECS.filter(x => x.type === 'enum')) {
      expect(s.enumValues!.length).toBeGreaterThan(0)
      expect(s.enumValues!).toContain(s.default as string)
    }
  })

  test('nodeId của mọi spec trỏ tới node có thật (và node đó khai báo lại paramKey)', () => {
    const nodeIds = new Set(NEURAL_NODES.map(n => n.id))
    for (const s of TUNING_SPECS) {
      expect(nodeIds.has(s.nodeId)).toBe(true)
      const node = NEURAL_NODES.find(n => n.id === s.nodeId)!
      expect(node.paramKeys).toContain(s.key)
    }
  })

  test('paramKeys của mọi node trỏ tới spec có thật (khớp 2 chiều)', () => {
    const specKeys = new Set(TUNING_SPECS.map(s => s.key))
    for (const n of NEURAL_NODES) {
      for (const pk of n.paramKeys) expect(specKeys.has(pk)).toBe(true)
    }
  })
})

describe('r81 · NEURAL_GRAPH integrity', () => {
  test('6 lớp đánh số 1..6, accent hợp lệ', () => {
    expect(NEURAL_LAYERS.length).toBe(6)
    const accents = new Set(['cyan', 'teal', 'amber', 'violet', 'fuchsia', 'emerald'])
    NEURAL_LAYERS.forEach((l, i) => {
      expect(l.index).toBe(i + 1)
      expect(accents.has(l.accent)).toBe(true)
    })
  })

  test('23 node · layer trỏ có thật · hàm số khai báo file', () => {
    expect(NEURAL_NODES.length).toBe(23)
    const layerIds = new Set(NEURAL_LAYERS.map(l => l.id))
    for (const n of NEURAL_NODES) {
      expect(layerIds.has(n.layer)).toBe(true)
      for (const fn of n.functions) expect(fn.file.length).toBeGreaterThan(0)
    }
  })

  test('37 cạnh · from/to trỏ node có thật · kind hợp lệ', () => {
    expect(NEURAL_EDGES.length).toBe(37)
    const nodeIds = new Set(NEURAL_NODES.map(n => n.id))
    const kinds = new Set(['data', 'reward', 'feedback', 'read'])
    for (const e of NEURAL_EDGES) {
      expect(nodeIds.has(e.from)).toBe(true)
      expect(nodeIds.has(e.to)).toBe(true)
      expect(kinds.has(e.kind)).toBe(true)
      expect(e.label.length).toBeGreaterThan(0)
    }
  })

  test('có dòng reward W1/W2 khép vòng học về q-table', () => {
    const rewards = NEURAL_EDGES.filter(e => e.kind === 'reward').map(e => `${e.from}→${e.to}`)
    expect(rewards).toContain('agent-response→q-table') // W2
    expect(rewards).toContain('adaptation→q-table')    // W1
  })

  test('graph export = layers+nodes+edges cùng nội dung', () => {
    expect(NEURAL_GRAPH.layers.length).toBe(NEURAL_LAYERS.length)
    expect(NEURAL_GRAPH.nodes.length).toBe(NEURAL_NODES.length)
    expect(NEURAL_GRAPH.edges.length).toBe(NEURAL_EDGES.length)
  })
})

// ==================== 2. VALIDATE (thuần) ====================

describe('r81 · validateTuningInput', () => {
  test('key lạ bị chặn', () => {
    expect(validateTuningInput('khong-co', '1').ok).toBe(false)
  })

  test('number: hợp lệ / ngoài phạm vi / không phải số', () => {
    expect(validateTuningInput('q_learning_alpha', '0.25')).toEqual({ ok: true, normalized: '0.25' })
    expect(validateTuningInput('q_learning_alpha', 0.3).ok).toBe(true)
    expect(validateTuningInput('q_learning_alpha', '0').ok).toBe(false)   // < min 0.01
    expect(validateTuningInput('q_learning_alpha', '1.5').ok).toBe(false) // > max 1
    expect(validateTuningInput('q_learning_alpha', 'abc').ok).toBe(false)
    expect(validateTuningInput('q_learning_alpha', true).ok).toBe(false)  // 'true' → NaN
  })

  test('number: float-junk làm tròn 6 chữ số lẻ', () => {
    const r = validateTuningInput('q_learning_gamma', '0.30000000000000004')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.normalized).toBe('0.3')
  })

  test('enum: chuẩn hoá trim+lowercase, giá trị lạ chặn', () => {
    expect(validateTuningInput('runtime_model_policy', ' SOFTMAX ')).toEqual({ ok: true, normalized: 'softmax' })
    expect(validateTuningInput('runtime_model_policy', 'on').ok).toBe(false)
    expect(validateTuningInput('adaptation_stats_gate', 'ON').ok).toBe(true)
    expect(validateTuningInput('adaptation_stats_gate', 'maybe').ok).toBe(false)
  })
})

// ==================== 3. CHUỖI HIỆU LỰC STORE > ENV > DEFAULT ====================

describe('r81 · resolve STORE > ENV > DEFAULT', () => {
  beforeEach(async () => {
    // Đảm bảo key sạch (DB copy từ production có thể mang row cũ)
    await resetTuningValue('q_learning_alpha')
    await resetTuningValue('runtime_model_tau')
    await resetTuningValue('episodic_epsilon')
    await resetTuningValue('adaptation_stats_gate')
    await resetTuningValue('matryoshka_pilot')
  })

  test('default khi không có store + không có env', () => {
    const prevTau = process.env.RUNTIME_MODEL_TAU
    const prevEps = process.env.TMO_EPISODIC_EPSILON
    delete process.env.RUNTIME_MODEL_TAU
    delete process.env.TMO_EPISODIC_EPSILON
    try {
      expect(getTuningNumber('q_learning_alpha')).toBe(0.1)
      expect(getTuningNumber('runtime_model_tau')).toBe(0.5)
      expect(getTuningNumber('episodic_epsilon')).toBe(0.15)
      expect(resolveTuning('runtime_model_policy').source).toBe('default')
      expect(getTuningEnum('runtime_model_policy')).toBe('off')
    } finally {
      if (prevTau !== undefined) process.env.RUNTIME_MODEL_TAU = prevTau
      if (prevEps !== undefined) process.env.TMO_EPISODIC_EPSILON = prevEps
    }
  })

  test('env fallback (số): parse + clamp [min,max]; rác → default', () => {
    const prev = process.env.RUNTIME_MODEL_TAU
    try {
      process.env.RUNTIME_MODEL_TAU = '1.5'
      const r = resolveTuning('runtime_model_tau')
      expect(r.source).toBe('env')
      expect(r.value).toBe(1.5)
      // '0' là giá trị HỢP LỆ → floor về min 0.05 (bảo toàn ngữ nghĩa FB-P6-R1-B-07)
      process.env.RUNTIME_MODEL_TAU = '0'
      expect(resolveTuning('runtime_model_tau').value).toBe(0.05)
      // vượt max → kẹp về max 5 (phân kỳ có ghi nhận trong spec design)
      process.env.RUNTIME_MODEL_TAU = '99'
      expect(resolveTuning('runtime_model_tau').value).toBe(5)
      // rác → default
      process.env.RUNTIME_MODEL_TAU = 'abc'
      expect(resolveTuning('runtime_model_tau').source).toBe('default')
      expect(resolveTuning('runtime_model_tau').value).toBe(0.5)
    } finally {
      if (prev !== undefined) process.env.RUNTIME_MODEL_TAU = prev
      else delete process.env.RUNTIME_MODEL_TAU
    }
  })

  test('env fallback (enum): envMap giữ ngữ nghĩa bản cũ', () => {
    const prevGate = process.env.ADAPTATION_STATS_GATE
    const prevPolicy = process.env.RUNTIME_MODEL_POLICY
    try {
      process.env.ADAPTATION_STATS_GATE = '1' // bản cũ: '1' → blocking
      expect(resolveTuning('adaptation_stats_gate').source).toBe('env')
      expect(getTuningEnum('adaptation_stats_gate')).toBe('on')
      process.env.ADAPTATION_STATS_GATE = 'garbage' // bản cũ: không blocking
      expect(resolveTuning('adaptation_stats_gate').source).toBe('default')
      expect(getTuningEnum('adaptation_stats_gate')).toBe('off')
      process.env.RUNTIME_MODEL_POLICY = 'softmax'
      expect(getTuningEnum('runtime_model_policy')).toBe('softmax')
      process.env.RUNTIME_MODEL_POLICY = 'lượt-đổi' // bản cũ: mọi giá trị ≠ softmax → off
      expect(getTuningEnum('runtime_model_policy')).toBe('off')
    } finally {
      if (prevGate !== undefined) process.env.ADAPTATION_STATS_GATE = prevGate
      else delete process.env.ADAPTATION_STATS_GATE
      if (prevPolicy !== undefined) process.env.RUNTIME_MODEL_POLICY = prevPolicy
      else delete process.env.RUNTIME_MODEL_POLICY
    }
  })

  test('STORE đè ENV: set → source store; reset → rơi về env/default', async () => {
    const prevGate = process.env.ADAPTATION_STATS_GATE
    try {
      process.env.ADAPTATION_STATS_GATE = 'on' // .env production đang on
      expect(resolveTuning('adaptation_stats_gate').source).toBe('env')
      await setTuningValue('adaptation_stats_gate', 'off')
      expect(getTuningEnum('adaptation_stats_gate')).toBe('off')
      expect(resolveTuning('adaptation_stats_gate').source).toBe('store')
      await resetTuningValue('adaptation_stats_gate')
      expect(resolveTuning('adaptation_stats_gate').source).toBe('env')
      expect(getTuningEnum('adaptation_stats_gate')).toBe('on')
    } finally {
      if (prevGate !== undefined) process.env.ADAPTATION_STATS_GATE = prevGate
      else delete process.env.ADAPTATION_STATS_GATE
      await resetTuningValue('adaptation_stats_gate')
    }
  })

  test('set giá trị rác → TuningValidationError (không ghi store)', async () => {
    await expect(setTuningValue('q_learning_alpha', '99')).rejects.toBeInstanceOf(TuningValidationError)
    await expect(setTuningValue('q_learning_alpha', 'abc')).rejects.toBeInstanceOf(TuningValidationError)
    await expect(setTuningValue('runtime_model_policy', 'on')).rejects.toBeInstanceOf(TuningValidationError)
    await expect(setTuningValue('key-ao', '1')).rejects.toBeInstanceOf(TuningValidationError)
    expect(getTuningNumber('q_learning_alpha')).toBe(0.1)
  })

  test('getTuningState: đủ 14 entry, effectiveValue/source/storeValue khớp', async () => {
    await setTuningValue('anomaly_iqr_k', '2.5')
    const state = await getTuningState()
    expect(state.length).toBe(14)
    const iqr = state.find(s => s.key === 'anomaly_iqr_k')!
    expect(iqr.source).toBe('store')
    expect(iqr.storeValue).toBe('2.5')
    expect(iqr.effectiveValue).toBe(2.5)
    const alpha = state.find(s => s.key === 'q_learning_alpha')!
    expect(alpha.effectiveValue).toBe(0.1)
    await resetTuningValue('anomaly_iqr_k')
  })
})

// ==================== 4. WIRING PIN — consumer đọc runtime thật ====================

describe('r81 · WIRING q-table: updateQ đọc α/γ runtime', () => {
  beforeEach(async () => {
    await resetTuningValue('q_learning_alpha')
    await resetTuningValue('q_learning_gamma')
    await db.qEntry.deleteMany({ where: { OR: [{ stateKey: 'r81-s' }, { stateKey: 'r81-t' }] } })
  })

  test('mặc định α=0.1/γ=0.9 đúng công thức (baseline không đổi)', async () => {
    await updateQ('r81-s', 'a1', 1, 'r81-s')
    // nhớ chuỗi tuần tự: đọc lại sau khi link hoàn tất
    const row = await db.qEntry.findUnique({ where: { stateKey_actionKey: { stateKey: 'r81-s', actionKey: 'a1' } } })
    expect(row?.qValue).toBeCloseTo(0.1, 10) // 0 + 0.1·(1 + 0.9·0 − 0)
    expect(row?.visits).toBe(1)
  })

  test('PIN α runtime: set α=0.5 → bước kế theo công thức α=0.5 (revert hằng số bị bắt)', async () => {
    await updateQ('r81-s', 'a1', 1, 'r81-s') // Q(a1)=0.1
    await setTuningValue('q_learning_alpha', '0.5')
    expect(getTuningNumber('q_learning_alpha')).toBe(0.5)
    await updateQ('r81-s', 'a1', 1, 'r81-s')
    const row = await db.qEntry.findUnique({ where: { stateKey_actionKey: { stateKey: 'r81-s', actionKey: 'a1' } } })
    // maxNext = Q(a1)=0.1 → Q' = 0.1 + 0.5·(1 + 0.9·0.1 − 0.1) = 0.1 + 0.495 = 0.595
    expect(row?.qValue).toBeCloseTo(0.595, 10)
    expect(row?.visits).toBe(2)
  })

  test('PIN γ runtime: set γ=0 → term tương lai triệt tiêu', async () => {
    await setTuningValue('q_learning_gamma', '0')
    await updateQ('r81-t', 'b1', 1, 'r81-t')
    const row = await db.qEntry.findUnique({ where: { stateKey_actionKey: { stateKey: 'r81-t', actionKey: 'b1' } } })
    // maxNext=0 (state trống) → Q = 0.1·(1 + 0·0 − 0) = 0.1 — không phân biệt γ ở
    // bước 1; bước 2 với entry thứ 2 mới thấy γ: maxNext = Q(b1)
    await updateQ('r81-t', 'b2', 1, 'r81-t')
    const row2 = await db.qEntry.findUnique({ where: { stateKey_actionKey: { stateKey: 'r81-t', actionKey: 'b2' } } })
    // maxNext = 0.1 → γ=0: Q = 0 + 0.1·(1 + 0·0.1 − 0) = 0.1 (giá trị γ=0.9 sẽ là 0.109)
    expect(row2?.qValue).toBeCloseTo(0.1, 10)
    void row
  })

  test('qLearningUpdate thuần KHÔNG đổi (α/γ mặc định export nguyên vẹn)', () => {
    expect(qLearningUpdate(0.1, 1, 0.1, 0.5, 0)).toBeCloseTo(0.55, 10) // γ=0: 0.1+0.5·(1+0−0.1)
    expect(qLearningUpdate(0.1, 1, 0.1, 0.5, 0.9)).toBeCloseTo(0.595, 10) // γ=0.9: 0.1+0.5·(1+0.09−0.1)
    expect(qLearningUpdate(0, 1, 0, 0.1, 0.9)).toBeCloseTo(0.1, 10)
  })
})

describe('r81 · WIRING episodic ε-greedy đọc runtime', () => {
  beforeEach(async () => {
    await resetTuningValue('episodic_epsilon')
  })

  const lessons = Array.from({ length: 8 }, (_, i) => ({
    id: `l${i}`, confidence: i === 5 ? 0.45 : 0.9, // rank 6 (index 5) đủ ngưỡng review 0.4
  }))

  test('PIN ε: set ε=1 → luôn thăm dò slot 5; set ε=0 → không bao giờ', async () => {
    await setTuningValue('episodic_epsilon', '1')
    const explored = applyEpsilonExploration(lessons, { rng: () => 0 })
    expect(explored.length).toBe(5)
    expect(explored[4]).toMatchObject({ id: 'l5', exploration: true }) // pool rank 6+

    await setTuningValue('episodic_epsilon', '0')
    const noExplore = applyEpsilonExploration(lessons, { rng: () => 0 })
    expect(noExplore[4]).toMatchObject({ id: 'l4' }) // giữ nguyên top-5 thuần exploit
    expect(noExplore[4].exploration ?? false).toBe(false)
  })

  test('opts.epsilon tiêm trực tiếp vẫn thắng (không đụng store — test cũ nguyên vẹn)', async () => {
    await setTuningValue('episodic_epsilon', '0')
    const forced = applyEpsilonExploration(lessons, { rng: () => 0, epsilon: 1 })
    expect(forced[4]).toMatchObject({ id: 'l5', exploration: true })
    await resetTuningValue('episodic_epsilon')
  })
})

describe('r81 · WIRING stats-gate + matryoshka STORE đè ENV', () => {
  beforeEach(async () => {
    await resetTuningValue('adaptation_stats_gate')
    await resetTuningValue('matryoshka_pilot')
  })

  test('isAdaptationStatsGateBlocking theo env (on) → store off đè → reset lại env', async () => {
    // .env production: ADAPTATION_STATS_GATE=on → env fallback blocking
    expect(isAdaptationStatsGateBlocking()).toBe(true)
    await setTuningValue('adaptation_stats_gate', 'off')
    expect(isAdaptationStatsGateBlocking()).toBe(false)
    await resetTuningValue('adaptation_stats_gate')
    expect(isAdaptationStatsGateBlocking()).toBe(true)
  })

  test('isMatryoshkaPilotEnabled: store on bật pilot dù env off', async () => {
    const prev = process.env.MATRYOSHKA_PILOT
    try {
      process.env.MATRYOSHKA_PILOT = 'off'
      expect(isMatryoshkaPilotEnabled()).toBe(false)
      await setTuningValue('matryoshka_pilot', 'on')
      expect(isMatryoshkaPilotEnabled()).toBe(true)
      await resetTuningValue('matryoshka_pilot')
      expect(isMatryoshkaPilotEnabled()).toBe(false)
      // env '1' vẫn map 'on' (ngữ nghĩa bản cũ)
      process.env.MATRYOSHKA_PILOT = '1'
      expect(isMatryoshkaPilotEnabled()).toBe(true)
    } finally {
      if (prev !== undefined) process.env.MATRYOSHKA_PILOT = prev
      else delete process.env.MATRYOSHKA_PILOT
      await resetTuningValue('matryoshka_pilot')
    }
  })
})

describe('r81 · WIRING near-dup threshold param hoá', () => {
  test('threshold mặc định runtime = 0.98 (không đổi hành vi r78)', () => {
    expect(getTuningNumber('doc_dedup_near_dup_threshold')).toBe(0.98)
  })

  test('threshold tiêm 0.9: hit 0.92 bị coi trùng (0.98 thì không)', () => {
    const probes = [[{ documentId: 'doc-khac', score: 0.92 }]]
    const loose = decideNearDuplicate('doc-moi', probes, 0.9)
    expect(loose.duplicate).toBe(true)
    const strict = decideNearDuplicate('doc-moi', probes, 0.98)
    expect(strict.duplicate).toBe(false)
  })
})

// ==================== 5. API ROUTE ====================

describe('r81 · API /api/neural-architecture', () => {
  beforeEach(async () => {
    await resetTuningValue('anomaly_iqr_k')
    await resetTuningValue('runtime_model_policy')
  })

  test('GET: graph 6 lớp · 23 node · 37 cạnh · 14 tuning · live là map', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.graph.layers.length).toBe(6)
    expect(json.graph.nodes.length).toBe(23)
    expect(json.graph.edges.length).toBe(37)
    expect(json.tuning.length).toBe(14)
    expect(typeof json.live).toBe('object')
    expect(json.live['q-table'][0].label).toBe('Q entries')
    expect(json.generatedAt).toBeTruthy()
  })

  test('POST set hợp lệ → 200 + entry source store + state cập nhật; reset → default', async () => {
    const setRes = await POST(new Request('http://t/api/neural-architecture', {
      method: 'POST',
      body: JSON.stringify({ action: 'set', key: 'anomaly_iqr_k', value: '2.5' }),
    }))
    expect(setRes.status).toBe(200)
    const setJson = await setRes.json()
    expect(setJson.ok).toBe(true)
    expect(setJson.entry.source).toBe('store')
    expect(setJson.entry.effectiveValue).toBe(2.5)
    expect(getTuningNumber('anomaly_iqr_k')).toBe(2.5)

    const resetRes = await POST(new Request('http://t/api/neural-architecture', {
      method: 'POST',
      body: JSON.stringify({ action: 'reset', key: 'anomaly_iqr_k' }),
    }))
    expect(resetRes.status).toBe(200)
    expect(getTuningNumber('anomaly_iqr_k')).toBe(1.5)
  })

  test('POST giá trị rác / key lạ / action lạ → 400 (không ghi gì)', async () => {
    const bad1 = await POST(new Request('http://t', { method: 'POST', body: JSON.stringify({ action: 'set', key: 'anomaly_iqr_k', value: '99' }) }))
    expect(bad1.status).toBe(400)
    const bad2 = await POST(new Request('http://t', { method: 'POST', body: JSON.stringify({ action: 'set', key: 'key-ao', value: '1' }) }))
    expect(bad2.status).toBe(400)
    const bad3 = await POST(new Request('http://t', { method: 'POST', body: JSON.stringify({ action: 'ping', key: 'anomaly_iqr_k' }) }))
    expect(bad3.status).toBe(400)
    expect(getTuningNumber('anomaly_iqr_k')).toBe(1.5) // không bị ghi bậy
  })

  test('POST policy=softmax qua API được ghi (điểm dừng #5 là mặc định OFF — API không tự bật)', async () => {
    const res = await POST(new Request('http://t', { method: 'POST', body: JSON.stringify({ action: 'set', key: 'runtime_model_policy', value: 'softmax' }) }))
    expect(res.status).toBe(200)
    expect(getTuningEnum('runtime_model_policy')).toBe('softmax')
    // DỌN: trả về OFF ngay trong test (điểm dừng #5 — không để lại state trên DB copy)
    const reset = await POST(new Request('http://t', { method: 'POST', body: JSON.stringify({ action: 'reset', key: 'runtime_model_policy' }) }))
    expect(reset.status).toBe(200)
    expect(getTuningEnum('runtime_model_policy')).toBe('off')
  })
})
