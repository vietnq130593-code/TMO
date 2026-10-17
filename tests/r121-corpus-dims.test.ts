/**
 * r121 (R31) — TỔNG QUAN CORPUS 6 CHIỀU BRAIN-D (corpus-dims.ts + wiring)
 * =============================================================================
 *
 * User chốt 2026-10-18 ("thêm vài chiều tổng quan corpus đi"): nhóm cfg
 * "trạng thái KB" trong input Brain-D mở rộng +6 chiều đếm corpus (log-scale)
 * — định nghĩa single-source ở src/lib/brain/corpus-dims.ts (BLUEPRINT-EVO-NAO
 * §8.3/§8.5.2 R31). File này pin:
 *  A. corpusDimScaled — công thức log10(1+v), đơn điệu, fail-open âm/NaN/∞.
 *  B. CORPUS_DIMS — 6 mục, thứ tự CỐ ĐỊNH (D3 input builder + UI cùng thứ tự).
 *  C. Wiring pins: registry planned label + spec-schema inputLabel đều 'cfg ~36'
 *     (đổi cùng lúc — single-source doctrine #9), route /api/brain gắn
 *     corpusOverview CHỈ cho knowledge (source-scan), UI brain-tab render
 *     khối corpus chỉ khi chọn knowledge (source-scan).
 *
 * Thuần — KHÔNG db (cùng chuẩn r114/r115 precedent).
 */

import { describe, expect, test } from 'bun:test'
import { CORPUS_DIMS, corpusDimScaled, type CorpusDimKey } from '../src/lib/brain/corpus-dims'
import { BRAIN_REGISTRY } from '../src/lib/brain/registry'
import { BRAIN_DRAFT_RULES } from '../src/lib/brain/spec-schema'
import { readFileSync } from 'node:fs'

// ==================== A. corpusDimScaled (log10(1+v) — fail-open) ====================

describe('r121 · A corpusDimScaled — log10(1+v) đơn điệu + fail-open', () => {
  test('A1 · log thập phân chuẩn: 0→0 · 9→1 · 99→2 · 999→3', () => {
    expect(corpusDimScaled(0)).toBe(0)
    expect(corpusDimScaled(9)).toBe(1)
    expect(corpusDimScaled(99)).toBeCloseTo(2, 12)
    expect(corpusDimScaled(999)).toBeCloseTo(3, 12)
  })

  test('A2 · dải corpus thật 2026-10: 96.354 node đồ thị → ~4.984', () => {
    // log10(96355) ≈ 4.9839… — nén 0..100K về ~0..5 như header doc
    expect(corpusDimScaled(96_354)).toBeCloseTo(Math.log10(96_355), 12)
    expect(corpusDimScaled(96_354)).toBeLessThan(5)
    expect(corpusDimScaled(96_354)).toBeGreaterThan(4.9)
  })

  test('A3 · đơn điệu: v lớn hơn → giá trị KHÔNG GIẢM', () => {
    let prev = -1
    for (const v of [0, 1, 2, 5, 10, 50, 100, 500, 1_000, 10_000, 100_000, 1_000_000]) {
      const s = corpusDimScaled(v)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })

  test('A4 · fail-open: âm / NaN / Infinity / -Infinity → 0 (không văng)', () => {
    expect(corpusDimScaled(-5)).toBe(0)
    expect(corpusDimScaled(-0.5)).toBe(0)
    expect(corpusDimScaled(Number.NaN)).toBe(0)
    expect(corpusDimScaled(Number.POSITIVE_INFINITY)).toBe(0)
    expect(corpusDimScaled(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

// ==================== B. CORPUS_DIMS — 6 mục thứ tự cố định ====================

describe('r121 · B CORPUS_DIMS — 6 chiều, thứ tự CỐ ĐỊNH (D3 builder dùng chung)', () => {
  test('B1 · đúng 6 mục theo đúng thứ tự — graphNodes, lessons, episodes, chunks, communities, memories', () => {
    expect(CORPUS_DIMS.map(d => d.key)).toEqual([
      'graphNodes',
      'lessons',
      'episodes',
      'chunks',
      'communities',
      'memories',
    ])
  })

  test('B2 · mỗi mục có label + source không rỗng (hiển thị UI/tooltip)', () => {
    for (const d of CORPUS_DIMS) {
      expect(d.label.length).toBeGreaterThan(0)
      expect(d.source.length).toBeGreaterThan(0)
    }
  })

  test('B3 · key là tập con đúng shape KnowledgeCorpusOverview (type-level pin qua runtime probe)', () => {
    // Probe 1 object theo type — mọi dim key phải đọc được số|null
    const sample: Record<CorpusDimKey, number | null> = {
      graphNodes: 96_354,
      lessons: 0,
      episodes: null,
      chunks: 868,
      communities: null,
      memories: 12,
    }
    for (const d of CORPUS_DIMS) {
      const v = sample[d.key]
      expect(v === null || typeof v === 'number').toBe(true)
    }
  })
})

// ==================== C. WIRING PINS (đổi cùng nhau — single-source #9) ====================

describe('r121 · C wiring — registry + spec-schema + route + UI đồng bộ cfg ~36', () => {
  test('C1 · registry planned input Brain-D: emb 2048 + cfg ~36', () => {
    const knowledge = BRAIN_REGISTRY.find(b => b.key === 'knowledge')
    expect(knowledge).toBeDefined()
    expect(knowledge!.planned.layers[0]?.unitsLabel).toBe('emb 2048 + cfg ~36')
  })

  test('C2 · spec-schema BRAIN_DRAFT_RULES.knowledge inputLabel: cfg ~36', () => {
    expect(BRAIN_DRAFT_RULES.knowledge.inputLabel).toBe('kb-features (emb 2048 + cfg ~36 — động)')
  })

  test('C3 · /api/brain route gắn corpusOverview CHỈ cho knowledge (source-scan)', () => {
    const src = readFileSync('src/app/api/brain/route.ts', 'utf8')
    expect(src).toContain("getKnowledgeCorpusOverview")
    expect(src).toContain("spec.key === 'knowledge' && corpusOverview")
  })

  test('C4 · brain-tab render khối corpus: import CORPUS_DIMS + gate knowledge (source-scan)', () => {
    const src = readFileSync('src/components/smolab/brain-tab.tsx', 'utf8')
    expect(src).toContain("from '@/lib/brain/corpus-dims'")
    expect(src).toContain("selectedBrainKey === 'knowledge' && selectedEntry.corpusOverview")
  })

  test('C5 · r114 pin cũ đã hiệu đính theo (không còn cfg ~30 lười stale)', () => {
    const src = readFileSync('tests/r114-brain-d-ghost-topology.test.ts', 'utf8')
    expect(src).not.toContain("cfg ~30")
    expect(src).toContain("cfg ~36")
  })
})
