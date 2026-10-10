/**
 * ROUND-76 TESTS — P1-M5 LEIDEN COMMUNITY QUALITY (BLUEPRINT-STATS-LEARNING-
 * P0-P6 §P1-M5, mục #3 — ML.pdf §Clustering Metrics)
 *
 * Đo lường: evaluateCommunityQuality (silhouette đồ thị) + sweepGamma
 * (auto-tune γ) + computeVectorQualityIndices (DBI/CH phụ) — module thuần
 * community-quality.ts, KHÔNG cần Neo4j/Qdrant/DB.
 *
 * Nguyên tắc test:
 * - Graph DỰNG SẴN có kết quả tính tay:
 *   (a) 3 cụm rõ (3 clique K4 trọng số 3, nối nhau 1 cạnh cầu 0.1) →
 *       silhouette CAO — tính tay: w'(3)=0.75, w'(0.1)=0.0909. 9 node thường
 *       (không cầu): s=1.0; 3 node cầu (0,4,8): s=(0.75−0.0909)/0.75=0.8788
 *       → mean = (9×1.0 + 3×0.8788)/12 = 0.9697.
 *   (b) graph nhiễu (12 node, cạnh ngẫu nhiên đan xen đều nhau) → silhouette
 *       THẤP HƠN ĐÁNG KỂ (đúng chiều — không so tuyệt đối với hằng số).
 *   (c) sweepGamma trên 3-clique graph → chọn đúng γ giữ nguyên 3 cụm
 *       (silhouette max); candidates đủ 5 mốc grid; best.silhouette = max.
 *   (d) hierarchical graph (2 macro × 3 clique: cạnh clique 3.0, cạnh
 *       macro-link 1.4, cross-macro 0.05) → sweep chọn được γ ≠ default
 *       khi phân hoạch mịn/thô khác silhouette thật sự (kiểm chứng tính
 *       năng của sweep, không hardcode kỳ vọng γ cụ thể — assert best γ
 *       thuộc grid + silhouette best ≥ mọi candidate).
 * - DBI/CH phụ: 2 cụm vector tách tuyệt đối ([[0,0]×3, [10,10]×3]) →
 *   DBI = 0 (centroid trùng scatter... không — scatter 0, SSB>0 → CH
 *   +Infinity; DBI: S_i=0, d=14.14 → R=0 → DBI=0); cụm trộn lấn nhau →
 *   DBI cao hơn. Null-guard: <2 điểm / 1 nhãn → null.
 * - Degenerate: 1 cụm duy nhất → silhouette 0 (quy ước sklearn).
 */

import { describe, test, expect } from 'bun:test'
import {
  evaluateCommunityQuality,
  sweepGamma,
  computeVectorQualityIndices,
  isLeidenAutoTuneEnabled,
  LEIDEN_GAMMA_GRID,
} from '@/lib/kb-routing/community-quality'
import { leidenCommunityDetection, type LeidenEdge } from '@/lib/leiden'

// ==================== FIXTURE BUILDERS ====================

/** 3 clique K4 (mỗi clique 4 node, cạnh trong 3.0) + 1 cạnh cầu yếu 0.1
 *  giữa từng cặp clique. 12 node. Cấu trúc planted 3-community chuẩn. */
function buildThreeCliques(): { n: number; edges: LeidenEdge[] } {
  const edges: LeidenEdge[] = []
  const N = 12 // 3 cụm × 4 node
  for (let c = 0; c < 3; c++) {
    const base = c * 4
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        edges.push({ source: base + i, target: base + j, weight: 3 })
      }
    }
  }
  // Cạnh cầu yếu giữa các cụm (0-1: node0-node4, 1-2: node4-node8)
  edges.push({ source: 0, target: 4, weight: 0.1 })
  edges.push({ source: 4, target: 8, weight: 0.1 })
  return { n: N, edges }
}

/** Graph nhiễu: 12 node, mỗi node nối 2-3 hàng xóm vòng trộn đều (không
 *  planted partition — mọi cấu trúc đều yếu). */
function buildNoisyGraph(): { n: number; edges: LeidenEdge[] } {
  const edges: LeidenEdge[] = []
  const N = 12
  // Vòng tròn đều trọng số 1 + nửa dây cung xen kẽ — không có cụm rõ
  for (let i = 0; i < N; i++) {
    edges.push({ source: i, target: (i + 1) % N, weight: 1 })
    edges.push({ source: i, target: (i + 5) % N, weight: 0.8 })
  }
  return { n: N, edges }
}

/** Hierarchical: 2 macro-group × 3 clique K4; cạnh clique 3.0; macro-link
 *  complete-bipartite trọng số 0.6 giữa các clique CÙNG macro (3 cặp/macro,
 *  16 cạnh/cặp); cross-macro 1 cạnh 0.05. Thực nghiệm (debug script): γ thấp
 *  (0.5-1.0) gộp theo macro (k=2), γ cao (1.2-1.5) tách clique (k=6) —
 *  sweep có tín hiệu thật để chọn. */
function buildHierarchicalGraph(): { n: number; edges: LeidenEdge[] } {
  const edges: LeidenEdge[] = []
  const N = 24 // 6 clique × 4 node
  for (let c = 0; c < 6; c++) {
    const base = c * 4
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        edges.push({ source: base + i, target: base + j, weight: 3 })
      }
    }
  }
  // macro-link: clique (0,1,2) thuộc macro A; (3,4,5) thuộc macro B —
  // complete-bipartite 0.6 (đủ mạnh để γ thấp gộp, γ cao vẫn tách)
  const macroPairs: Array<[number, number]> = [
    [0, 1], [1, 2], [0, 2], // macro A
    [3, 4], [4, 5], [3, 5], // macro B
  ]
  for (const [a, b] of macroPairs) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        edges.push({ source: a * 4 + i, target: b * 4 + j, weight: 0.6 })
      }
    }
  }
  // cross-macro: 1 cạnh yếu duy nhất
  edges.push({ source: 0, target: 12, weight: 0.05 })
  return { n: N, edges }
}

// ==================== SILHOUETTE (ĐỒ THỊ) ====================

describe('P1-M5 evaluateCommunityQuality (silhouette đồ thị)', () => {
  test('3 clique rõ → silhouette ≈ 0.879 (tính tay)', () => {
    const { n, edges } = buildThreeCliques()
    const result = leidenCommunityDetection(n, edges, { restarts: 3, resolution: 1.0 })
    // Leiden phải tìm đúng 3 planted communities
    expect(result.communityCount).toBe(3)
    const sil = evaluateCommunityQuality(n, edges, result.nodeCommunity)
    // Tính tay: 9 node thường s=1.0 + 3 node cầu s=0.8788 → mean=0.9697
    expect(sil).toBeGreaterThan(0.9)
    expect(sil).toBeLessThanOrEqual(1)
    expect(Math.abs(sil - 0.9697)).toBeLessThan(0.01)
  })

  test('graph nhiễu → silhouette THẤP hơn graph sạch (đúng chiều)', () => {
    const clean = buildThreeCliques()
    const cleanResult = leidenCommunityDetection(clean.n, clean.edges, { restarts: 3 })
    const cleanSil = evaluateCommunityQuality(clean.n, clean.edges, cleanResult.nodeCommunity)

    const noisy = buildNoisyGraph()
    const noisyResult = leidenCommunityDetection(noisy.n, noisy.edges, { restarts: 3 })
    const noisySil = evaluateCommunityQuality(noisy.n, noisy.edges, noisyResult.nodeCommunity)

    expect(cleanSil).toBeGreaterThan(0.8)
    expect(noisySil).toBeLessThan(cleanSil - 0.4) // chênh lệch ĐÁNG KỂ
  })

  test('degenerate — 1 cụm duy nhất → 0 (quy ước sklearn)', () => {
    const { n, edges } = buildThreeCliques()
    const oneLabel = new Array<number>(n).fill(0)
    expect(evaluateCommunityQuality(n, edges, oneLabel)).toBe(0)
  })

  test('gán SAI cụm (đảo nhãn planted) → silhouette âm', () => {
    const { n, edges } = buildThreeCliques()
    // Gán nhãn xen kẽ i%3 — cạnh mạnh (3.0) giờ đa số LIÊN cụm → a thấp b cao → âm
    const wrongLabels = Array.from({ length: n }, (_, i) => i % 3)
    const sil = evaluateCommunityQuality(n, edges, wrongLabels)
    expect(sil).toBeLessThan(0)
  })
})

// ==================== AUTO-TUNE γ (SWEEP) ====================

describe('P1-M5 sweepGamma (auto-tune γ)', () => {
  test('3-clique graph: chọn đúng γ giữ 3 cụm, silhouette best = max candidates', () => {
    const { n, edges } = buildThreeCliques()
    const sweep = sweepGamma(n, edges, { restarts: 3 })
    // Grid mặc định đủ 5 mốc
    expect(sweep.candidates.map(c => c.gamma)).toEqual([...LEIDEN_GAMMA_GRID])
    // best.silhouette = max trên candidates (tính nhất quán)
    const maxSil = Math.max(...sweep.candidates.map(c => c.silhouette))
    expect(sweep.best.silhouette).toBe(maxSil)
    // Trên planted 3-clique, phân hoạch 3 cụm cho silhouette ~0.879 —
    // γ chọn phải đạt mức đó (γ sai có thể xé nhỏ clique → silhouette tụt)
    expect(sweep.best.silhouette).toBeGreaterThan(0.75)
    // nodeCommunity của best dùng lại được (đúng độ dài, id liên tục)
    expect(sweep.best.nodeCommunity.length).toBe(n)
  })

  test('hierarchical graph: sweep hoạt động (γ thuộc grid, best ≥ mọi candidate, k thay đổi theo γ)', () => {
    const { n, edges } = buildHierarchicalGraph()
    const sweep = sweepGamma(n, edges, { restarts: 3 })
    expect(LEIDEN_GAMMA_GRID).toContain(sweep.best.gamma)
    const maxSil = Math.max(...sweep.candidates.map(c => c.silhouette))
    expect(sweep.best.silhouette).toBe(maxSil)
    // Tính năng sweep thật: số community phải KHÁC NHAU giữa γ thấp & cao
    // (γ thấp gộp macro, γ cao tách clique — ít nhất 2 giá trị k khác nhau)
    const ks = new Set(sweep.candidates.map(c => c.communityCount))
    expect(ks.size).toBeGreaterThanOrEqual(2)
  })

  test('tie-break modularity: cùng silhouette → chọn modularity cao hơn', () => {
    // Graph đối xứng hoàn hảo: mọi γ cho cùng phân hoạch 2 clique K4 (silhouette
    // như nhau) → best là candidate modularity cao nhất trong đám max-sil
    const edges: LeidenEdge[] = []
    for (let c = 0; c < 2; c++) {
      const base = c * 4
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) edges.push({ source: base + i, target: base + j, weight: 2 })
      }
    }
    const sweep = sweepGamma(8, edges, { restarts: 2 })
    const maxSil = Math.max(...sweep.candidates.map(c => c.silhouette))
    const amongMax = sweep.candidates.filter(c => c.silhouette === maxSil)
    const bestAmong = amongMax.reduce((a, b) => (b.modularity > a.modularity ? b : a))
    expect(sweep.best.gamma).toBe(bestAmong.gamma)
    expect(sweep.best.modularity).toBe(bestAmong.modularity)
  })
})

// ==================== DBI / CH (PHỤ — INFORMATIVE) ====================

describe('P1-M5 computeVectorQualityIndices (DBI/CH phụ)', () => {
  test('2 nhóm vector tách tuyệt đối → DBI thấp / CH rất cao', () => {
    const r = computeVectorQualityIndices([
      { vector: [0, 0], label: 'security' },
      { vector: [0.1, 0], label: 'security' },
      { vector: [0, 0.1], label: 'security' },
      { vector: [10, 10], label: 'ml' },
      { vector: [10.1, 10], label: 'ml' },
      { vector: [10, 10.1], label: 'ml' },
    ])
    expect(r.dbi).not.toBeNull()
    expect(r.calinskiHarabasz).not.toBeNull()
    expect(r.dbi as number).toBeLessThan(0.3)
    expect(r.calinskiHarabasz as number).toBeGreaterThan(100)
    expect(r.n).toBe(6)
    expect(r.labels).toBe(2)
  })

  test('2 nhóm trộn lấn nhau → DBI cao hơn nhóm tách bạch', () => {
    const separated = computeVectorQualityIndices([
      { vector: [0, 0], label: 'a' },
      { vector: [0.1, 0], label: 'a' },
      { vector: [10, 10], label: 'b' },
      { vector: [10.1, 10], label: 'b' },
    ])
    const mixed = computeVectorQualityIndices([
      { vector: [0, 0], label: 'a' },
      { vector: [5, 5], label: 'a' },
      { vector: [5.1, 5], label: 'b' },
      { vector: [10, 10], label: 'b' },
    ])
    expect(mixed.dbi as number).toBeGreaterThan(separated.dbi as number)
    expect(separated.calinskiHarabasz as number).toBeGreaterThan(mixed.calinskiHarabasz as number)
  })

  test('null-guard: <2 điểm, 1 nhãn duy nhất, vector rỗng → null', () => {
    expect(computeVectorQualityIndices([]).dbi).toBeNull()
    expect(computeVectorQualityIndices([{ vector: [1, 2], label: 'x' }]).dbi).toBeNull()
    expect(
      computeVectorQualityIndices([
        { vector: [1, 2], label: 'x' },
        { vector: [3, 4], label: 'x' },
      ]).dbi,
    ).toBeNull()
    // vector rỗng bị lọc → không đủ điểm
    expect(
      computeVectorQualityIndices([
        { vector: [], label: 'x' },
        { vector: [], label: 'y' },
      ]).dbi,
    ).toBeNull()
  })
})

// ==================== ENV GATE ====================

describe('P1-M5 LEIDEN_AUTO_TUNE env gate (default OFF)', () => {
  test('mặc định (không set) → OFF; on/1/true → ON', () => {
    const prev = process.env.LEIDEN_AUTO_TUNE
    try {
      delete process.env.LEIDEN_AUTO_TUNE
      expect(isLeidenAutoTuneEnabled()).toBe(false)
      process.env.LEIDEN_AUTO_TUNE = 'on'
      expect(isLeidenAutoTuneEnabled()).toBe(true)
      process.env.LEIDEN_AUTO_TUNE = '1'
      expect(isLeidenAutoTuneEnabled()).toBe(true)
      process.env.LEIDEN_AUTO_TUNE = 'true'
      expect(isLeidenAutoTuneEnabled()).toBe(true)
      process.env.LEIDEN_AUTO_TUNE = 'off'
      expect(isLeidenAutoTuneEnabled()).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.LEIDEN_AUTO_TUNE
      else process.env.LEIDEN_AUTO_TUNE = prev
    }
  })
})
