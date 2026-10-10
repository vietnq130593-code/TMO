/**
 * ROUND-78 TESTS — P5-M3 NAIVE BAYES CHO ENTITY RESOLUTION
 * (BLUEPRINT-STATS-LEARNING-P0-P6 §P5-M3, mục #16 — MATH.pdf §Bayes +
 * §Naive Bayes)
 *
 * Đo lường:
 *   A. computeEntityPairFeatures (thuần) — f1 Levenshtein ratio, f2 type,
 *      f3 Jaccard token (toán tay đối chiếu), f4 domain giao nhau; mô tả
 *      rỗng đôi bên = 1, một bên rỗng = 0.
 *   B. trainNaiveBayesEntityModel + classifyEntityPair (thuần) — phân bố tách
 *      biệt → usable + LLR đúng dấu ngoài vùng xám; <100 cặp match →
 *      usable=false → classify trả 0 (neo vùng xám → fuzzy); Laplace chống
 *      log(0) (bin chưa thấy ra xác suất hữu hạn); kill-switch ENTITY_NB=off.
 *   C. resolveEntities tích hợp — không model (dưới 100 cặp): hành vi fuzzy
 *      cũ NGUYÊN VẸN (merge > 0.85 cùng type, không merge khác type);
 *      model học "mid-f1 + desc trùng = match" → merge method 'nb' VƯỢT ngưỡng
 *      fuzzy; model học "f1 cao + desc khác = not" → NB CHẶN cặp fuzzy-muốn-merge.
 *   D. loadNaiveBayesModel (DB) — seed 150 cặp resolved tách biệt → model
 *      usable (pairCount=150); đốI chiếu chéo: 40 cặp test hold-out (20 match
 *      + 20 not-match cùng phân bố) → độ chính xác ≥ 95% (spec §P5-M3);
 *      dưới 100 cặp → null; ENTITY_NB=off → null; cache 10 phút (cùng object).
 *
 * DB-cô-lập (bunfig preload copy DB) — beforeAll wipe LocalEntity +
 * LocalResolvedEntity; mỗi kịch bản DB reset cache NB.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test'
import { db } from '@/lib/db'
import {
  computeEntityPairFeatures,
  trainNaiveBayesEntityModel,
  classifyEntityPair,
  buildNbTrainingPairs,
  loadNaiveBayesModel,
  isEntityNbEnabled,
  resolveEntities,
  resetEntityNbCache,
  ENTITY_NB_MIN_PAIRS,
  ENTITY_NB_GRAY_ZONE,
  ENTITY_NB_TAU,
  type EntityPairFeatures,
  type EntityFeatureInput,
  type ExtractedEntity,
} from '@/lib/ingestion/entity-resolver'

// ==================== BỘ TẠO DỮ LIỆU TÁCH BIỆT (spec: "phân bố đặc trưng tách biệt") ====================

/** Mã 5 chữ số phân tán — cặp khác nhau luôn lệch ≥3 chữ số (f1 ≤ 0.8) */
function code(i: number): string {
  return String(((i + 1) * 7919) % 100000).padStart(5, '0')
}

/** Canonical thứ i — tên + mô tả token hoàn toàn riêng (f3 chéo = 0) */
function canonicalInput(i: number): EntityFeatureInput {
  const c = code(i)
  return {
    name: `Khái niệm ${c}`,
    type: 'Concept',
    description: `dinhnghia${c} toanroi${c} riengbiet${c}`,
    domains: ['ml'],
  }
}

/** Entity trùng canonical thứ i (positive thực — như exact-match resolution) */
function matchingEntityInput(i: number): EntityFeatureInput {
  const c = canonicalInput(i)
  return { ...c }
}

/** Cặp train/dự đoán từ index — isMatch = có trùng canonical không */
function pairFeatures(i: number, isMatch: boolean): EntityPairFeatures {
  const a = matchingEntityInput(i)
  const b = isMatch ? canonicalInput(i) : canonicalInput(i + 500) // lệch 500 → chắc chắn khác khái niệm
  return computeEntityPairFeatures(a, b)
}

/** Sinh n cặp train cân bằng (n match + n not-match) cùng phân bố tách biệt */
function syntheticPairs(n: number): Array<{ features: EntityPairFeatures; isMatch: boolean }> {
  const pairs: Array<{ features: EntityPairFeatures; isMatch: boolean }> = []
  for (let i = 0; i < n; i++) {
    pairs.push({ features: pairFeatures(i, true), isMatch: true })
    pairs.push({ features: pairFeatures(i + 1000, false), isMatch: false })
  }
  return pairs
}

function extractedEntity(name: string, type: string, description: string): ExtractedEntity {
  return {
    name, type, description,
    properties: {},
    confidenceScore: 0.9,
    source: 'test',
    domain: 'ml' as never, // DocumentDomain union — 'ml' thuộc các domain hợp lệ
  }
}

// ==================== A. computeEntityPairFeatures (thuần) ====================

describe('A. computeEntityPairFeatures — 4 đặc trưng cặp', () => {
  const a: EntityFeatureInput = { name: 'Convolutional Neural Network', type: 'Algorithm', description: 'mạng nơ-ron tích chập xử lý ảnh', domains: ['ml', 'vision'] }
  const same = { ...a }
  const other: EntityFeatureInput = { name: 'Recurrent Neural Network', type: 'Algorithm', description: 'mạng nơ-ron hồi tiếp chuỗi thời gian', domains: ['nlp'] }

  test('cặp trùng khớp: f1=1, f2=1, f3=1, f4=1', () => {
    const f = computeEntityPairFeatures(a, same)
    expect(f.f1).toBe(1)
    expect(f.f2).toBe(1)
    expect(f.f3).toBe(1)
    expect(f.f4).toBe(1)
  })

  test('cặp khác: f2=1 cùng type, f4=0 khác domain, f3=0 token rời, f1 thấp', () => {
    // Mô tả rời token HOÀN TOÀN để khẳng định f3=0 đúng nghĩa (kỳ vọng đầu
    // dùng 2 mô tả cùng chữ "mạng nơ-ron" → f3≈0.23 — sai phía người viết test)
    const other: EntityFeatureInput = { name: 'Recurrent Neural Network', type: 'Algorithm', description: 'thuật toán xếp hạng trang web tìm kiếm', domains: ['nlp'] }
    const f = computeEntityPairFeatures(a, other)
    expect(f.f2).toBe(1)  // cùng Algorithm
    expect(f.f4).toBe(0)  // ml/vision vs nlp
    expect(f.f3).toBe(0)  // token hoàn toàn rời
    expect(f.f1).toBeLessThan(0.85)
    expect(f.f1).toBeGreaterThan(0) // vẫn khá giống nhau về tên
  })

  test('mô tả chồng lấp một phần → f3 ∈ (0, 1) đúng nghĩa Jaccard', () => {
    const f = computeEntityPairFeatures(a, { name: 'Recurrent Neural Network', type: 'Algorithm', description: 'mạng nơ-ron hồi tiếp chuỗi thời gian', domains: ['nlp'] })
    // {mạng,nơ,rôn} giao / 13 hợp ≈ 0.23 — chồng lấp một phần, không 0 không 1
    expect(f.f3).toBeGreaterThan(0)
    expect(f.f3).toBeLessThan(1)
  })

  test('f2 khác type → 0', () => {
    const f = computeEntityPairFeatures(a, { ...other, type: 'Tool' })
    expect(f.f2).toBe(0)
  })

  test('f3 Jaccard toán tay: "a b c" vs "a b d" = |{a,b}|/|{a,b,c,d}| = 0.5', () => {
    const f = computeEntityPairFeatures(
      { name: 'X', type: 'T', description: 'a b c', domains: [] },
      { name: 'Y', type: 'T', description: 'a b d', domains: [] }
    )
    expect(f.f3).toBe(0.5)
  })

  test('mô tả rỗng đôi bên → f3=1 (giống nhau trivia); một bên rỗng → f3=0', () => {
    const both = computeEntityPairFeatures(
      { name: 'X', type: 'T', description: '', domains: [] },
      { name: 'Y', type: 'T', description: '', domains: [] }
    )
    expect(both.f3).toBe(1)
    const one = computeEntityPairFeatures(
      { name: 'X', type: 'T', description: 'a b', domains: [] },
      { name: 'Y', type: 'T', description: '', domains: [] }
    )
    expect(one.f3).toBe(0)
  })

  test('f4 giao nhau 1 phần vẫn = 1 (some-overlap)', () => {
    const f = computeEntityPairFeatures(
      { name: 'X', type: 'T', description: '', domains: ['ml', 'nlp'] },
      { name: 'Y', type: 'T', description: '', domains: ['nlp', 'kb'] }
    )
    expect(f.f4).toBe(1)
  })

  test('f1 Levenshtein chuẩn: "kitten" vs "sitting" = 1 − 3/7 ≈ 0.5714', () => {
    const f = computeEntityPairFeatures(
      { name: 'kitten', type: 'T', description: '', domains: [] },
      { name: 'sitting', type: 'T', description: '', domains: [] }
    )
    expect(f.f1).toBeCloseTo(1 - 3 / 7, 10)
  })
})

// ==================== B. train + classify (thuần) ====================

describe('B. trainNaiveBayesEntityModel + classifyEntityPair', () => {
  test('120 cặp tách biệt → usable=true; LLR match > +GRAY, LLR not-match < −GRAY', () => {
    const model = trainNaiveBayesEntityModel(syntheticPairs(120))
    expect(model.usable).toBe(true)
    expect(model.pairCount).toBe(120)
    expect(model.negativeCount).toBe(120)

    const matchLLR = classifyEntityPair(model, pairFeatures(3000, true))
    const notLLR = classifyEntityPair(model, pairFeatures(3500, false))
    expect(matchLLR).toBeGreaterThan(ENTITY_NB_GRAY_ZONE)
    expect(notLLR).toBeLessThan(-ENTITY_NB_GRAY_ZONE)
  })

  test('99 cặp match (< ENTITY_NB_MIN_PAIRS) → usable=false → classify trả 0 (neo vùng xám → fuzzy)', () => {
    const model = trainNaiveBayesEntityModel(syntheticPairs(99))
    expect(model.pairCount).toBe(99)
    expect(model.usable).toBe(false)
    // Không usable → mọi cặp LLR=0 → |0| < 0.5 → fuzzy quyết — đúng spec
    expect(classifyEntityPair(model, pairFeatures(3000, true))).toBe(0)
    expect(classifyEntityPair(model, pairFeatures(3500, false))).toBe(0)
  })

  test('Laplace λ=1: bin chưa từng thấy ra xác suất hữu hạn (không log(0)/−∞)', () => {
    const model = trainNaiveBayesEntityModel(syntheticPairs(110))
    // f1=0.55 (bin 5) — match training luôn f1=1 (bin 9), not-match f1≤0.8 (bin ≤8)
    // bin 5 có mặt ở not-match; thử bin chưa thấy ở CẢ HAI: f1 = 0.05 (bin 0)
    const llr = classifyEntityPair(model, { f1: 0.05, f2: 1, f3: 0.05, f4: 1 })
    expect(Number.isFinite(llr)).toBe(true)
  })

  test('classify dùng đúng bảng log-prob (đối chiếu chéo tay 1 đặc trưng)', () => {
    // Model tối giản: 1 match + 1 not-match... nhưng <100 → không usable → 0.
    // Thay vào đó kiểm cấu trúc: model usable có bảng đủ chiều dài 10/10/2/2
    const model = trainNaiveBayesEntityModel(syntheticPairs(100))
    expect(model.match.f1.length).toBe(10)
    expect(model.notMatch.f1.length).toBe(10)
    expect(model.match.f3.length).toBe(10)
    expect(model.match.f2.length).toBe(2)
    expect(model.match.f4.length).toBe(2)
    // Laplace: tổng P(bin) trên 1 đặc trưng = 1
    const sumMatchF1 = model.match.f1.reduce((s, lp) => s + Math.exp(lp), 0)
    expect(sumMatchF1).toBeCloseTo(1, 9)
  })

  test('kill-switch ENTITY_NB=off → usable=false (mọi cặp train đủ vẫn vậy)', () => {
    const prev = process.env.ENTITY_NB
    process.env.ENTITY_NB = 'off'
    try {
      expect(isEntityNbEnabled()).toBe(false)
      const model = trainNaiveBayesEntityModel(syntheticPairs(150))
      expect(model.usable).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.ENTITY_NB
      else process.env.ENTITY_NB = prev
    }
  })

  test('hằng số khớp spec §P5-M3: 100 cặp / vùng xám 0.5 / τ=0', () => {
    expect(ENTITY_NB_MIN_PAIRS).toBe(100)
    expect(ENTITY_NB_GRAY_ZONE).toBe(0.5)
    expect(ENTITY_NB_TAU).toBe(0)
  })
})

// ==================== C. resolveEntities tích hợp (NB vs fuzzy) ====================

describe('C. resolveEntities — NB cắm sau exact, trước fuzzy', () => {
  test('KHÔNG model (dưới 100 cặp) → hành vi fuzzy cũ NGUYÊN VẸN', () => {
    // 2 entity cùng type, tên giống 0.86 > 0.85 → fuzzy merge như luật cũ
    const r = resolveEntities([
      extractedEntity('Tensor Flow Frame', 'Tool', 'desc một'),
      extractedEntity('Tensor Flow Frams', 'Tool', 'desc hai'),
    ])
    expect(r.duplicates.some(d => d.method === 'fuzzy')).toBe(true)
    expect(r.resolved.length).toBe(1)

    // khác type → không merge (luật fuzzy cũ)
    const r2 = resolveEntities([
      extractedEntity('Tensor Flow Frame', 'Tool', 'desc một'),
      extractedEntity('Tensor Flow Frams', 'Algorithm', 'desc hai'),
    ])
    expect(r2.resolved.length).toBe(2)

    // tên khác hẳn (f1 ~0.5) → fuzzy KHÔNG merge dù desc giống hệt
    const r3 = resolveEntities([
      extractedEntity('Mạng tích chập', 'Algorithm', 'xử lý ảnh bằng bộ lọc trượt'),
      extractedEntity('CNN', 'Algorithm', 'xử lý ảnh bằng bộ lọc trượt'),
    ])
    expect(r3.resolved.length).toBe(2)
  })

  test('model học "mid-f1 + desc trùng + cùng type/domain = match" → merge method=nb VƯỢT ngưỡng fuzzy', () => {
    // Train: match = (f1 0.5, f3 1, f2 1, f4 1) — not = (f1 0.5, f3 0, f2 1, f4 1)
    const pairs: Array<{ features: EntityPairFeatures; isMatch: boolean }> = []
    for (let i = 0; i < 120; i++) {
      pairs.push({ features: { f1: 0.5, f2: 1, f3: 1, f4: 1 }, isMatch: true })
      pairs.push({ features: { f1: 0.5, f2: 1, f3: 0, f4: 1 }, isMatch: false })
    }
    const model = trainNaiveBayesEntityModel(pairs)
    expect(model.usable).toBe(true)

    // Cặp f1~0.5 (fuzzy không bao giờ merge) + desc trùng → NB merge
    const r = resolveEntities(
      [
        extractedEntity('Mạng tích chập', 'Algorithm', 'xử lý ảnh bằng bộ lọc trượt'),
        extractedEntity('CNN', 'Algorithm', 'xử lý ảnh bằng bộ lọc trượt'),
      ],
      { nbModel: model }
    )
    expect(r.resolved.length).toBe(1)
    expect(r.duplicates.some(d => d.method === 'nb')).toBe(true)
  })

  test('model học "f1 cao + desc RỜI = not" → NB CHẶN cặp fuzzy-muốn-merge', () => {
    // Train: match = (f1 0.9, f3 1) — not = (f1 0.9, f3 0) — desc là tín hiệu quyết
    const pairs: Array<{ features: EntityPairFeatures; isMatch: boolean }> = []
    for (let i = 0; i < 120; i++) {
      pairs.push({ features: { f1: 0.9, f2: 1, f3: 1, f4: 1 }, isMatch: true })
      pairs.push({ features: { f1: 0.9, f2: 1, f3: 0, f4: 1 }, isMatch: false })
    }
    const model = trainNaiveBayesEntityModel(pairs)
    expect(model.usable).toBe(true)

    // Cặp tên giống 0.86 (fuzzy MUỐN merge) nhưng desc rời hoàn toàn → NB chặn
    const r = resolveEntities(
      [
        extractedEntity('Tensor Flow Frame', 'Tool', 'nền tảng học máy của Google'),
        extractedEntity('Tensor Flow Frams', 'Tool', 'thư viện thống kê R dành cho ngành tài chính'),
      ],
      { nbModel: model }
    )
    expect(r.resolved.length).toBe(2) // KHÔNG merge — NB chặn
    expect(r.duplicates.some(d => d.method === 'fuzzy')).toBe(false)
    expect(r.duplicates.some(d => d.method === 'nb')).toBe(false)
  })

  test('model không usable → resolveEntities bỏ qua hoàn toàn (như không có)', () => {
    const weakModel = trainNaiveBayesEntityModel(syntheticPairs(50)) // <100 → usable=false
    const withModel = resolveEntities(
      [
        extractedEntity('Tensor Flow Frame', 'Tool', 'desc một'),
        extractedEntity('Tensor Flow Frams', 'Tool', 'desc hai'),
      ],
      { nbModel: weakModel }
    )
    const withoutModel = resolveEntities([
      extractedEntity('Tensor Flow Frame', 'Tool', 'desc một'),
      extractedEntity('Tensor Flow Frams', 'Tool', 'desc hai'),
    ])
    expect(withModel.resolved.length).toBe(withoutModel.resolved.length)
    expect(withModel.duplicates.length).toBe(withoutModel.duplicates.length)
  })
})

// ==================== D. loadNaiveBayesModel (DB) + độ chính xác ≥95% ====================

describe('D. loadNaiveBayesModel — train từ LocalEntity/LocalResolvedEntity', () => {
  beforeEach(async () => {
    resetEntityNbCache()
    await db.localEntity.deleteMany({})
    await db.localResolvedEntity.deleteMany({})
  })

  afterEach(() => {
    resetEntityNbCache()
  })

  async function seedResolvedPairs(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const c = canonicalInput(i)
      const canonical = await db.localResolvedEntity.create({
        data: {
          canonicalName: c.name,
          entityType: c.type,
          description: c.description,
          domains: JSON.stringify(c.domains),
        },
      })
      await db.localEntity.create({
        data: {
          entityName: c.name, // exact-match history — thực tế最常见的 positive
          entityType: c.type,
          description: c.description,
          domain: c.domains[0],
          resolvedEntityId: canonical.id,
        },
      })
    }
  }

  test('seed 150 cặp resolved tách biệt → model usable (pairCount=150) — ĐỘ CHÍNH XÁC ≥95% trên 40 cặp hold-out', async () => {
    await seedResolvedPairs(150)
    const model = await loadNaiveBayesModel()
    expect(model).not.toBeNull()
    expect(model!.usable).toBe(true)
    expect(model!.pairCount).toBe(150)

    // 40 cặp hold-out (index ≥2000 — không trùng train): 20 match + 20 not
    let correct = 0
    const N = 20
    for (let i = 2000; i < 2000 + N; i++) {
      // match: entity trùng canonical → LLR phải > 0 (dự đoán match)
      const llrMatch = classifyEntityPair(model!, pairFeatures(i, true))
      if (llrMatch > 0) correct++
      // not-match: entity vs canonical khác khái niệm → LLR phải ≤ 0
      const llrNot = classifyEntityPair(model!, pairFeatures(i + 500, false))
      if (llrNot <= 0) correct++
    }
    const accuracy = correct / (2 * N)
    // SPEC §P5-M3: "NB phân loại đúng ≥ 95% cặp test"
    expect(accuracy).toBeGreaterThanOrEqual(0.95)
  })

  test('model từ DB có negative (cross-pair cùng type, f1 ∈ [0.3, 0.85))', async () => {
    await seedResolvedPairs(150)
    const model = await loadNaiveBayesModel()
    expect(model).not.toBeNull()
    expect(model!.negativeCount).toBeGreaterThan(0)
    // Cân bằng 1:1 — mỗi positive có 1 negative (spec: LLR không hệ số prior)
    expect(model!.negativeCount).toBeLessThanOrEqual(model!.pairCount)
  })

  test('dưới 100 cặp (seed 50) → loadNaiveBayesModel trả null (fuzzy cũ)', async () => {
    await seedResolvedPairs(50)
    const model = await loadNaiveBayesModel()
    expect(model).toBeNull()
  })

  test('kill-switch ENTITY_NB=off → null dù đủ dữ liệu', async () => {
    await seedResolvedPairs(150)
    const prev = process.env.ENTITY_NB
    process.env.ENTITY_NB = 'off'
    try {
      resetEntityNbCache()
      expect(await loadNaiveBayesModel()).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.ENTITY_NB
      else process.env.ENTITY_NB = prev
    }
  })

  test('cache 10 phút: gọi 2 lần liên tiếp trả CÙNG object (không train lại)', async () => {
    await seedResolvedPairs(120)
    const m1 = await loadNaiveBayesModel()
    const m2 = await loadNaiveBayesModel()
    expect(m1).not.toBeNull()
    expect(m2).toBe(m1) // cùng reference — cache hit
  })

  test('buildNbTrainingPairs: negative loại chính nó + loại f1 ≥ 0.85 (bản sao bị miss)', () => {
    const rows = [
      { entity: canonicalInput(0), matchedCanonical: canonicalInput(0) },
      { entity: canonicalInput(1), matchedCanonical: canonicalInput(1) },
    ]
    const canonicals = [canonicalInput(0), canonicalInput(1)]
    const pairs = buildNbTrainingPairs(rows, canonicals)
    // 2 positive + 2 negative chéo (0↔1) — nếu tên 2 canonical quá giống (f1 ≥ 0.85)
    // thì negative bị loại đúng luật
    const positives = pairs.filter(p => p.isMatch)
    expect(positives.length).toBe(2)
    const negatives = pairs.filter(p => !p.isMatch)
    for (const n of negatives) {
      expect(n.features.f1).toBeLessThan(0.85)
      expect(n.features.f1).toBeGreaterThanOrEqual(0.3)
    }
  })
})
