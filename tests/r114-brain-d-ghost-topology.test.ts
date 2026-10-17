/**
 * ROUND-114 TESTS — R24-b · GHOST UI TOPOLOGY BRAIN-D "TRI THỨC" (§8.5 mốc a)
 * (BLUEPRINT-EVO-NAO-P1-P5 §8.3/§8.5 — não thứ 4 trong BRAIN_REGISTRY hiện
 * thị NGAY từ D1 dù chưa có model: ghost topology + tiến độ thức tỉnh kép)
 *
 * Đo lường (THUẦN cho A/B/C/E — không DB, không React; D là static-scan
 * nguồn theo precedent r110-A5/r93-C):
 *   A. Registry: entry 'knowledge' tồn tại đúng key/name/title/flag/
 *      flagTuningKey/phase; 2 signals min 100/300 đúng key đếm route;
 *      planned.layers 6 mục (input + trunk 32/16 + 3 cụm) với headGroup
 *      đúng 3 mục cuối (mode/retrieval/meta); 'knowledge' KHÔNG nằm trong
 *      BRAIN_TRAINABLE_KEYS (nút train tự tắt tới D3); BrainKey type compile
 *      (gán 'knowledge' vào biến BrainKey).
 *   B. Cờ kill-switch (§8.3 — TUNING_SPECS #33/#34 nối CUỐI mảng): đủ trường
 *      precedent cờ #32 kb_consult_log (key/label/envKey/default/envMap/
 *      enum off-on/nodeId kb-access/warning/appliesTo); TUNING_SPECS.length
 *      = 34 (PIN UPDATE R24-b: 32 → 34) + không key trùng.
 *   C. Geometry backward-compat TUYỆT ĐỐI: bộ cột cũ KHÔNG headGroup → mọi
 *      số pin r90 giữ nguyên (width 390/colX 34/height 331) + headGroups
 *      rỗng + 2 lần chạy deep-equal.
 *   D. (static-scan) Route /api/brain đếm 2 signal key khớp registry —
 *      'kbLogsTotal'/'kbLogsWithOutcome' + kbConsultLog.count xuất hiện
 *      trong nguồn route (registry signals khớp key counts map).
 *   E. Geometry headGroup (§8.5.2): khe giữa 2 cột khác nhóm = stepX +
 *      headGroupGap(64); cột kề nhau CÙNG nhóm không khe thêm; headGroups
 *      trả đúng span/label/x1/x2; tất định (2 lần deep-equal).
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRAIN_REGISTRY,
  BRAIN_TRAINABLE_KEYS,
  type BrainKey,
  type BrainSpec,
} from '@/lib/brain/registry'
import { TUNING_SPECS, getTuningSpec } from '@/lib/learning/neural-types'
import { buildStageLayout, STAGE_LIMITS, type StageColumn } from '@/lib/brain/stage-geometry'

// ==================== A. REGISTRY — não thứ 4 'knowledge' ====================

describe('r114 · A registry Brain-D "Tri Thức" (§8.5 mốc a ghost UI)', () => {
  const knowledge = BRAIN_REGISTRY.find(b => b.key === 'knowledge')

  test('A1 entry tồn tại đúng key/name/title/phase/flag/flagTuningKey (SAU policy — não thứ 4)', () => {
    expect(knowledge).toBeDefined()
    expect(BRAIN_REGISTRY.length).toBe(4)
    expect(BRAIN_REGISTRY[3]?.key).toBe('knowledge') // thêm SAU policy theo §2.1
    expect(BRAIN_REGISTRY.map(b => b.key)).toEqual(['calibration_v3', 'surrogate', 'policy', 'knowledge'])
    const k = knowledge as BrainSpec
    expect(k.name).toBe('Tri Thức')
    expect(k.title).toBe('Brain-D · Tri Thức (Knowledge Policy Head)')
    expect(k.phase).toBe('BRAIN-D3')
    expect(k.flag).toBe('RUNTIME_KNOWLEDGE')
    expect(k.flagTuningKey).toBe('runtime_knowledge')
    expect(k.inputModes).toEqual(['kb-features'])
    expect(k.defaultInputMode).toBe('kb-features')
    // §8.3 "kill-switch 2 cờ" — cờ organ riêng Tầng 1 hiển thị badge phụ
    expect(k.extraFlagTuningKeys).toEqual(['knowledge_organ_strategy'])
    // role nói đúng bản chất policy head (không phải search-engine)
    expect(k.role).toContain('CÁCH dùng KB')
  })

  test('A2 tiến độ thức tỉnh KÉP — 2 signals min 100 (D2) / 300 (D3) đúng key đếm route', () => {
    const k = knowledge as BrainSpec
    expect(k.signals).toHaveLength(2)
    const [s1, s2] = k.signals
    expect(s1.key).toBe('kbLogsTotal')
    expect(s1.min).toBe(100)
    expect(s1.table).toContain('KbConsultLog')
    expect(s1.source).toContain('§8.1')
    expect(s2.key).toBe('kbLogsWithOutcome')
    expect(s2.min).toBe(300)
    expect(s2.table).toContain('runId')
    expect(s2.source).toContain('§8.1')
  })

  test('A3 planned.layers: input emb+cfg → trunk 32/16 tanh → 3 cụm; headGroup ĐÚNG 3 mục cuối', () => {
    const k = knowledge as BrainSpec
    // 6 lớp theo liệt kê §2.1 (input + 2 trunk + 3 cụm — blueprint §8.5.2
    // diagram: "trunk 2 lớp ẩn 32/16 tanh"; task ghi nhãn "7 cột" nhưng liệt
    // kê chỉ 6 mục layer + 1 dòng loss — theo ĐÚNG bản liệt kê + blueprint)
    expect(k.planned.layers).toHaveLength(6)
    const [l0, l1, l2, l3, l4, l5] = k.planned.layers
    expect(l0.units).toBe(0)
    expect(l0.unitsLabel).toBe('emb 2048 + cfg ~30')
    expect(l1).toMatchObject({ units: 32, activation: 'tanh' })
    expect(l2).toMatchObject({ units: 16, activation: 'tanh' })
    // 3 cụm đầu ra — một quyết định (§8.3)
    expect(l3).toMatchObject({ units: 3, activation: 'softmax', headGroup: 'mode', groupLabel: 'Chế độ vận dụng' })
    expect(l4).toMatchObject({ units: 9, activation: 'sigmoid', headGroup: 'retrieval', groupLabel: 'Tham số truy xuất' })
    expect(l5).toMatchObject({ units: 2, activation: 'sigmoid', headGroup: 'meta', groupLabel: 'Meta' })
    // 3 cột đầu KHÔNG có nhóm (additive — não cũ không set)
    expect(l0.headGroup).toBeUndefined()
    expect(l1.headGroup).toBeUndefined()
    expect(l2.headGroup).toBeUndefined()
    expect(k.planned.loss).toBe('CE + BCE (3 tầng — một quyết định)')
  })

  test('A4 knowledge KHÔNG nằm trong BRAIN_TRAINABLE_KEYS (nút train tự tắt tới D3)', () => {
    expect(BRAIN_TRAINABLE_KEYS).toEqual(['calibration_v3', 'surrogate', 'policy'])
    expect(BRAIN_TRAINABLE_KEYS.includes('knowledge')).toBe(false)
  })

  test('A5 BrainKey type compile — ' + "'knowledge' hợp lệ trong union", () => {
    const key: BrainKey = 'knowledge'
    expect(key).toBe('knowledge')
  })

  test('A6 não A/B/C giữ nguyên — không headGroup, không extraFlagTuningKeys (additive)', () => {
    for (const old of ['calibration_v3', 'surrogate', 'policy'] as const) {
      const spec = BRAIN_REGISTRY.find(b => b.key === old)!
      expect(spec.planned.layers.every(l => l.headGroup === undefined && l.groupLabel === undefined)).toBe(true)
      expect(spec.extraFlagTuningKeys).toBeUndefined()
    }
  })
})

// ==================== B. CỜ KILL-SWITCH #33/#34 (§8.3) ====================

describe('r114 · B cờ runtime_knowledge + knowledge_organ_strategy (TUNING_SPECS #33/#34)', () => {
  test('B1 runtime_knowledge — kill-switch tầng runtime Brain-D, default off, node kb-access', () => {
    const spec = getTuningSpec('runtime_knowledge')
    expect(spec).toBeDefined()
    expect(spec!.type).toBe('enum')
    expect(spec!.enumValues).toEqual(['off', 'on'])
    expect(spec!.default).toBe('off')
    expect(spec!.envKey).toBe('RUNTIME_KNOWLEDGE')
    expect(spec!.nodeId).toBe('kb-access')
    expect(spec!.label).toBe('RUNTIME_KNOWLEDGE')
    // placeholder đặt tên sớm — warning nói rõ ý nghĩa từ BRAIN-D3
    expect(spec!.warning).toContain('BRAIN-D3')
    expect(typeof spec!.appliesTo).toBe('string')
    // envMap chuẩn hoá on/1/true → on · off/0/false → off
    expect(spec!.envMap!('on')).toBe('on')
    expect(spec!.envMap!('1')).toBe('on')
    expect(spec!.envMap!('true')).toBe('on')
    expect(spec!.envMap!('off')).toBe('off')
    expect(spec!.envMap!('rác')).toBeUndefined()
  })

  test('B2 knowledge_organ_strategy — kill-switch organ Tầng 1 (chế độ vận dụng), default off, node kb-access', () => {
    const spec = getTuningSpec('knowledge_organ_strategy')
    expect(spec).toBeDefined()
    expect(spec!.type).toBe('enum')
    expect(spec!.enumValues).toEqual(['off', 'on'])
    expect(spec!.default).toBe('off')
    expect(spec!.envKey).toBe('KNOWLEDGE_ORGAN_STRATEGY')
    expect(spec!.nodeId).toBe('kb-access')
    expect(spec!.label).toBe('KNOWLEDGE_ORGAN_STRATEGY')
    // off = mọi lượt consult dùng context-block (hành vi mặc định hôm nay)
    expect(spec!.description).toContain('context-block')
    expect(spec!.description).toContain('structured-subgraph')
    expect(spec!.description).toContain('traversal-plan')
  })

  test('B3 TUNING_SPECS.length = 36 (PIN UPDATE R24-c: 34 → 36 — thêm brain_evolve + brain_search_global)', () => {
    // PIN UPDATE R24-b (2026-10-17): 32 → 34 — thêm runtime_knowledge +
    // knowledge_organ_strategy (Brain-D ghost §8.5/§8.3 — node kb-access).
    expect(TUNING_SPECS.length).toBe(36)
    expect(TUNING_SPECS[32]?.key).toBe('runtime_knowledge') // cờ #33
    expect(TUNING_SPECS[33]?.key).toBe('knowledge_organ_strategy') // cờ #34
    const keys = TUNING_SPECS.map(s => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    // cờ #32 precedent vẫn NGUYÊN vẹn ngay trước 2 cờ mới
    expect(TUNING_SPECS[31]?.key).toBe('kb_consult_log')
  })
})

// ==================== C. GEOMETRY — backward-compat TUYỆT ĐỐI ====================

describe('r114 · C buildStageLayout không headGroup → GIỐNG HỆT trước thay đổi (pin r90)', () => {
  // Cùng bộ cột r90-J (spec thật Brain-A 10→16→1) — mọi số pin cũ
  const columns: StageColumn[] = [
    { units: 10, display: 0, label: '1-hot cfg', activation: 'linear', locked: true },
    { units: 16, display: 0, label: '×16', activation: 'tanh', locked: false },
    { units: 1, display: 0, label: 'sigmoid', activation: 'sigmoid', locked: true },
  ]

  test('C1 pin r90 giữ nguyên: width 390 · colX[0] 34 · bước 161 · height 331 · 27 nơ-ron', () => {
    const lay = buildStageLayout(columns)
    expect(lay.width).toBe(390)
    expect(lay.colX[0]).toBeCloseTo(34, 10)
    expect(lay.colX[1] - lay.colX[0]).toBeCloseTo(161, 10)
    expect(lay.height).toBe(331)
    expect(lay.neurons).toHaveLength(27)
    expect(lay.rowStep).toEqual([17, 17, 17])
    // headGroups rỗng — não A/B/C không có nhóm (additive)
    expect(lay.headGroups).toEqual([])
  })

  test('C2 tất định — 2 lần chạy deep-equal (kể cả headGroups mới)', () => {
    expect(buildStageLayout(columns)).toEqual(buildStageLayout(columns))
  })

  test('C3 bộ cột cũ khác (2 cột [256, 8]) — pin r90: width 340, colX [34, 306], height 586', () => {
    const lay = buildStageLayout([
      { units: 256, display: 0, label: '×256', activation: 'tanh', locked: false },
      { units: 8, display: 0, label: '8', activation: 'tanh', locked: false },
    ])
    expect(lay.width).toBe(340)
    expect(lay.colX).toEqual([34, 306])
    expect(lay.height).toBe(586)
    expect(lay.headGroups).toEqual([])
  })
})

// ==================== D. (static-scan) ROUTE ĐẾM 2 SIGNAL KEY ====================

describe('r114 · D route /api/brain đếm KbConsultLog (§8.5.3 — không route mới)', () => {
  test('D1 nguồn route chứa 2 đếm kbLogsTotal/kbLogsWithOutcome + kbConsultLog.count (runId NOT NULL)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'app', 'api', 'brain', 'route.ts'), 'utf-8')
    expect(src).toContain('kbLogsTotal')
    expect(src).toContain('kbLogsWithOutcome')
    expect(src).toContain('db.kbConsultLog.count()')
    expect(src).toContain('runId: { not: null }')
    // registry signals khớp key counts map: counts được tham chiếu qua
    // `counts[sig.key]` + 2 key đếm xuất hiện trong object counts (A2 đã pin
    // key — chốt đôi tĩnh registry↔route)
    const knowledge = BRAIN_REGISTRY.find(b => b.key === 'knowledge')!
    expect(src).toContain(knowledge.signals[0].key)
    expect(src).toContain(knowledge.signals[1].key)
    expect(src).toContain('counts[sig.key]')
  })
})

// ==================== E. GEOMETRY — headGroup additive (§8.5.2) ====================

describe('r114 · E buildStageLayout có headGroup — khe nhóm + headGroups span/label', () => {
  // Spec thật Brain-D (planned.layers §8.5.2): input 8 (đại diện khi inputDim
  // null — precedent surrogate dormant) → 32 → 16 → mode 3 → retrieval 9 → meta 2
  const knowledgeCols: StageColumn[] = [
    { units: 8, display: 0, label: 'emb 2048 + cfg ~30', activation: 'input', locked: true },
    { units: 32, display: 0, label: '32', activation: 'tanh', locked: true },
    { units: 16, display: 0, label: '16', activation: 'tanh', locked: true },
    { units: 3, display: 0, label: '3', activation: 'softmax', locked: true, headGroup: 'mode', groupLabel: 'Chế độ vận dụng' },
    { units: 9, display: 0, label: '9', activation: 'sigmoid', locked: true, headGroup: 'retrieval', groupLabel: 'Tham số truy xuất' },
    { units: 2, display: 0, label: '2', activation: 'sigmoid', locked: true, headGroup: 'meta', groupLabel: 'Meta' },
  ]

  test('E1 STAGE_LIMITS.headGroupGap = 64 (§8.5.2 — khe viewBox units giữa 2 nhóm)', () => {
    expect(STAGE_LIMITS.headGroupGap).toBe(64)
  })

  test('E2 khe giữa 2 cột khác nhóm = stepX + 64; 3 biên (undefined→mode→retrieval→meta)', () => {
    const lay = buildStageLayout(knowledgeCols)
    // width = clamp(6×130, 340, 900) = 780; marginX 34; gapTotal = 3×64 = 192
    // stepX = (780 − 68 − 192)/5 = 104
    expect(lay.width).toBe(780)
    const stepX = 104
    // colX = [34, 138, 242, 410, 578, 746] — khe sau cột 2/3/4 dồn 64/cạnh
    expect(lay.colX[0]).toBeCloseTo(34, 10)
    expect(lay.colX[1]).toBeCloseTo(138, 10)
    expect(lay.colX[2]).toBeCloseTo(242, 10)
    expect(lay.colX[3]).toBeCloseTo(410, 10)
    expect(lay.colX[4]).toBeCloseTo(578, 10)
    expect(lay.colX[5]).toBeCloseTo(746, 10)
    // biên 16(tanh, không nhóm) → mode: 410 − 242 = 168 = stepX + 64
    expect(lay.colX[3] - lay.colX[2]).toBeCloseTo(stepX + STAGE_LIMITS.headGroupGap, 10)
    // biên mode → retrieval · retrieval → meta
    expect(lay.colX[4] - lay.colX[3]).toBeCloseTo(stepX + STAGE_LIMITS.headGroupGap, 10)
    expect(lay.colX[5] - lay.colX[4]).toBeCloseTo(stepX + STAGE_LIMITS.headGroupGap, 10)
    // cột thường kề nhau (không biên nhóm): chênh = stepX thuần
    expect(lay.colX[1] - lay.colX[0]).toBeCloseTo(stepX, 10)
    expect(lay.colX[2] - lay.colX[1]).toBeCloseTo(stepX, 10)
    // cột CUỐI vẫn chạm biên phải (margin đối xứng — layout cân)
    expect(lay.width - lay.colX[5]).toBeCloseTo(34, 10)
  })

  test('E3 headGroups trả đúng 3 span + label §8.3 + x1/x2 khớp colX', () => {
    const lay = buildStageLayout(knowledgeCols)
    expect(lay.headGroups).toHaveLength(3)
    const [mode, retrieval, meta] = lay.headGroups
    expect(mode).toMatchObject({ id: 'mode', label: 'Chế độ vận dụng', fromCol: 3, toCol: 3 })
    expect(mode.x1).toBeCloseTo(lay.colX[3], 10)
    expect(mode.x2).toBeCloseTo(lay.colX[3], 10)
    expect(retrieval).toMatchObject({ id: 'retrieval', label: 'Tham số truy xuất', fromCol: 4, toCol: 4 })
    expect(meta).toMatchObject({ id: 'meta', label: 'Meta', fromCol: 5, toCol: 5 })
  })

  test('E4 cột KỀ NHAU CÙNG nhóm KHÔNG khe thêm (chỉ biên khác nhóm có 64)', () => {
    // [thường, mode, mode] — 1 biên duy nhất (undefined→mode); mode→mode dính liền
    const lay = buildStageLayout([
      { units: 4, display: 0, label: 'in', activation: 'input', locked: true },
      { units: 3, display: 0, label: '3', activation: 'softmax', locked: true, headGroup: 'mode', groupLabel: 'Chế độ vận dụng' },
      { units: 2, display: 0, label: '2', activation: 'softmax', locked: true, headGroup: 'mode' },
    ])
    // width = clamp(3×130) = 390; stepX = (390 − 68 − 64)/2 = 129
    const stepX = 129
    expect(lay.colX[1] - lay.colX[0]).toBeCloseTo(stepX + STAGE_LIMITS.headGroupGap, 10) // 193
    expect(lay.colX[2] - lay.colX[1]).toBeCloseTo(stepX, 10) // CÙNG nhóm — không khe
    // 1 nhóm chạy 2 cột: fromCol 1 → toCol 2, label lấy cột ĐẦU nhóm
    expect(lay.headGroups).toEqual([{
      id: 'mode',
      label: 'Chế độ vận dụng', // groupLabel cột đầu nhóm (cột 2 không set → vẫn đúng)
      fromCol: 1,
      toCol: 2,
      x1: lay.colX[1],
      x2: lay.colX[2],
    }])
  })

  test('E5 groupLabel thiếu → fallback §8.3 (Chế độ vận dụng/Tham số truy xuất/Meta)', () => {
    const lay = buildStageLayout([
      { units: 3, display: 0, label: '3', activation: 'softmax', locked: true, headGroup: 'retrieval' },
    ])
    expect(lay.headGroups).toEqual([{ id: 'retrieval', label: 'Tham số truy xuất', fromCol: 0, toCol: 0, x1: lay.colX[0], x2: lay.colX[0] }])
  })

  test('E6 tất định — 2 lần chạy deep-equal (knowledge 6 cột có nhóm)', () => {
    expect(buildStageLayout(knowledgeCols)).toEqual(buildStageLayout(knowledgeCols))
  })

  test('E7 height KHÔNG phụ thuộc khe nhóm (chỉ colX đổi — contentSpan giữ geometry v3)', () => {
    const withGroups = buildStageLayout(knowledgeCols)
    const withoutGroups = buildStageLayout(knowledgeCols.map(c => ({ ...c, headGroup: undefined, groupLabel: undefined })))
    expect(withGroups.height).toBe(withoutGroups.height)
    expect(withGroups.rowStep).toEqual(withoutGroups.rowStep)
    expect(withGroups.neurons.map(n => [n.col, n.row, n.realIndex])).toEqual(
      withoutGroups.neurons.map(n => [n.col, n.row, n.realIndex]),
    )
  })
})
