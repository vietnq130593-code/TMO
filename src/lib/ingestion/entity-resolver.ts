/**
 * Entity Resolver - Entity resolution and deduplication
 * 
 * Step 1: Exact match (case-insensitive, trim whitespace) → merge immediately
 * Step 2: Fuzzy match using Levenshtein distance (threshold: similarity > 0.85) → merge
 * Step 3: LLM-based match for ambiguous cases (optional, high cost)
 *
 * P5-M3 (BLUEPRINT-STATS-LEARNING §P5-M3, mục #16 — MATH.pdf §Bayes +
 * §Naive Bayes): lớp NAIVE BAYES học từ lịch sử resolve, cắm SAU exact-match
 * TRƯỚC fuzzy — fuzzy trở thành fallback cho vùng xám |LLR| < 0.5. Chỉ bật khi
 * có ≥ ENTITY_NB_MIN_PAIRS cặp resolved tích lũy (LocalEntity.resolvedEntityId
 * → LocalResolvedEntity là ground truth sẵn có); dưới ngưỡng → nguyên trạng
 * thái cũ. Kill-switch env ENTITY_NB=off (mặc định on-khi-đủ-dữ-liệu).
 * 
 * Merge strategy: combine properties (union), max confidence score, increment occurrence_count
 *
 * Phase 2 SMOLAB Prop 2.5 — Embedding-based entity resolution (NEW):
 *   Secondary path used by writeback.ts when persisting LLM-extracted entities.
 *   resolveEntityByNameAndEmbedding() generates a 2048-dim embedding from
 *   `${name}: ${description}` then queries Neo4j for nearest entities via
 *   vector.similarity.cosine() scalar function (linear scan per label) OR via
 *   db.index.vector.queryNodes() procedure (uses HNSW vector index when available).
 *   Match threshold: raw cosine > 0.85 → Neo4j-normalized score > 0.925
 *   (Neo4j's vector.similarity.cosine() returns (1 + raw_cosine) / 2 ∈ [0, 1]).
 *
 *   The pre-existing Levenshtein-based resolveEntities() is KEPT — it is still
 *   used during PDF ingestion (fast pre-filter, no API call). The embedding-based
 *   resolver is the secondary path for writeback (single LLM-extracted entity at
 *   a time, can afford the embedding API call).
 */

import type { DocumentDomain } from './pdf-parser'
import { generateEmbedding } from '@/lib/embeddings'
import { readCypher, ENTITY_LABELS, type EntityLabel } from '@/lib/neo4j'
import { db } from '@/lib/db'

// ==================== INPUT TYPE ====================

/** Entity extracted by LLM — input to the resolution pipeline.
 *  Mirrors the ExtractedEntity interface from process/route.ts for standalone use. */
export interface ExtractedEntity {
  name: string
  type: string
  description: string
  properties: Record<string, string | number | boolean>
  confidenceScore: number
  source: string
  domain: DocumentDomain
}

// ==================== TYPES ====================

export interface ResolvedEntity {
  id?: string
  canonicalName: string
  entityType: string
  description: string
  properties: Record<string, string | number | boolean>
  avgConfidence: number
  occurrenceCount: number
  domains: DocumentDomain[]
  sourceNames: string[] // All names that were merged into this entity
}

export interface DuplicatePair {
  merged: string
  into: string
  method: 'exact' | 'fuzzy' | 'llm' | 'nb' // 'nb' — P5-M3 Naive Bayes quyết
  similarity: number
}

export interface ResolutionResult {
  resolved: ResolvedEntity[]
  duplicates: DuplicatePair[]
  stats: {
    totalInput: number
    afterExactMatch: number
    afterFuzzyMatch: number
    finalCount: number
  }
}

// ==================== LEVENSHTEIN DISTANCE ====================

/**
 * Calculate Levenshtein distance between two strings
 * Simple implementation without external dependencies
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length

  // Create a matrix of size (m+1) x (n+1)
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  // Initialize base cases
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,      // deletion
        dp[i][j - 1] + 1,      // insertion
        dp[i - 1][j - 1] + cost // substitution
      )
    }
  }

  return dp[m][n]
}

/**
 * Calculate similarity ratio between two strings (0 to 1)
 */
function stringSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1.0
  const distance = levenshteinDistance(a, b)
  return 1 - distance / maxLen
}

// ==================== EXACT MATCH ====================

/**
 * Step 1: Exact match (case-insensitive, trim whitespace)
 */
function exactMatchResolution(entities: ExtractedEntity[]): {
  resolved: Map<string, ResolvedEntity>
  duplicates: DuplicatePair[]
} {
  const resolved = new Map<string, ResolvedEntity>()
  const duplicates: DuplicatePair[] = []
  // Map from normalized name to canonical name
  const nameToCanonical = new Map<string, string>()

  for (const entity of entities) {
    const normalizedName = entity.name.toLowerCase().trim()

    const existingCanonical = nameToCanonical.get(normalizedName)
    if (existingCanonical) {
      // Merge into existing entity
      const existing = resolved.get(existingCanonical)!
      existing.occurrenceCount++
      existing.avgConfidence = Math.max(existing.avgConfidence, entity.confidenceScore)
      existing.sourceNames.push(entity.name)
      
      // Merge properties (union)
      if (entity.properties && typeof entity.properties === 'object') {
        for (const [key, value] of Object.entries(entity.properties)) {
          if (!(key in existing.properties)) {
            existing.properties[key] = value
          }
        }
      }

      // Merge descriptions - keep the longer one
      if (entity.description && entity.description.length > existing.description.length) {
        existing.description = entity.description
      }

      // Add domain if not present
      if (!existing.domains.includes(entity.domain)) {
        existing.domains.push(entity.domain)
      }

      duplicates.push({
        merged: entity.name,
        into: existingCanonical,
        method: 'exact',
        similarity: 1.0,
      })
    } else {
      // New entity
      const canonicalName = entity.name.trim()
      const resolvedEntity: ResolvedEntity = {
        canonicalName,
        entityType: entity.type,
        description: entity.description || '',
        properties: { ...(entity.properties || {}) },
        avgConfidence: entity.confidenceScore,
        occurrenceCount: 1,
        domains: [entity.domain],
        sourceNames: [entity.name],
      }
      resolved.set(canonicalName, resolvedEntity)
      nameToCanonical.set(normalizedName, canonicalName)
    }
  }

  return { resolved, duplicates }
}

// ==================== P5-M3 — NAIVE BAYES ENTITY RESOLUTION (mục #16) ====================
//
// MATH.pdf §Bayes + §Naive Bayes: thay quyết định fuzzy thuần (một ngưỡng
// Levenshtein cứng) bằng xác suất CÓ HỌC từ lịch sử resolve. Đặc trưng cặp
// (entity, ứng viên canonical):
//   f1 = similarity tên (Levenshtein ratio 0-1)  — rời rạc hóa 10 bin [0,1]
//   f2 = cùng entityType? 1:0
//   f3 = Jaccard token description (0-1)          — rời rạc hóa 10 bin [0,1]
//   f4 = cùng domain? 1:0
// NB nhị phân (match/not-match), Laplace smoothing λ=1 (MATH.pdf §Bayes):
//   LLR = Σ_k log P(f_k|match) − Σ_k log P(f_k|not)   (không hệ số prior —
//   cặp train lấy cân bằng 1:1 nên prior ~1, theo công thức spec §P5-M3)
// Match khi LLR > τ (τ=0 khởi điểm — cân bằng, hiệu chỉnh bằng sweep sau).
// Vùng xám |LLR| < 0.5 → giao về fuzzy cũ (fallback).

/** Ngưỡng cặp resolved tối thiểu để NB bật (spec §P5-M3: "≥100 cặp mới bật") */
export const ENTITY_NB_MIN_PAIRS = 100
/** Vùng xám |LLR| < 0.5 → fuzzy cũ quyết (spec §P5-M3) */
export const ENTITY_NB_GRAY_ZONE = 0.5
/** τ khởi điểm 0 — cân bằng (spec §P5-M3, hiệu chỉnh bằng sweep sau) */
export const ENTITY_NB_TAU = 0
/** Số bin rời rạc hóa cho f1/f3 (MATH.pdf §Naive Bayes — continuous → binned) */
const ENTITY_NB_FEATURE_BINS = 10
/** Model cache 10 phút (spec §P5-M3: "cache 10 phút, train trong RAM") */
const ENTITY_NB_CACHE_MS = 10 * 60 * 1000
/** Cap số row đọc để train — chống phình trên DB lớn (đủ 100+ là dùng được) */
const ENTITY_NB_MAX_ROWS = 5000

export interface EntityPairFeatures {
  /** f1 — Levenshtein ratio tên (0-1) */
  f1: number
  /** f2 — cùng entityType (1/0) */
  f2: 0 | 1
  /** f3 — Jaccard token description (0-1) */
  f3: number
  /** f4 — cùng domain (1/0) */
  f4: 0 | 1
}

/** Đầu vào đặc trưng — đủ trường tính f1-f4 */
export interface EntityFeatureInput {
  name: string
  type: string
  description: string
  domains: string[]
}

/** Token hóa description cho Jaccard (lowercase, tách phi ký tự, bỏ token rỗng) */
function tokenize(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length > 0)
  )
}

/** Jaccard |A∩B|/|A∪B| — 2 mô tả rỗng = 1 (giống nhau trivia), 1 rỗng = 0 */
function jaccardTokenSimilarity(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.size === 0 && tb.size === 0) return 1
  if (ta.size === 0 || tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

/** Tính 4 đặc trưng cặp (entity, ứng viên) — thuần. */
export function computeEntityPairFeatures(a: EntityFeatureInput, b: EntityFeatureInput): EntityPairFeatures {
  const f1 = stringSimilarity(a.name.toLowerCase().trim(), b.name.toLowerCase().trim())
  const f2: 0 | 1 = a.type.trim().toLowerCase() === b.type.trim().toLowerCase() ? 1 : 0
  const f3 = jaccardTokenSimilarity(a.description, b.description)
  const f4: 0 | 1 = a.domains.some(d => b.domains.includes(d)) ? 1 : 0
  return { f1, f2, f3, f4 }
}

/** Model NB sau train — bảng log P(bin | class) cho từng đặc trưng. */
export interface NaiveBayesEntityModel {
  trainedAt: number
  /** Số cặp match (positive) dùng train — usable yêu cầu ≥ ENTITY_NB_MIN_PAIRS */
  pairCount: number
  /** Số cặp not-match (negative) dùng train */
  negativeCount: number
  /** ≥100 cặp match ∧ kill-switch không tắt */
  usable: boolean
  /** log P(feature-bin | class) — mảng dài ENTITY_NB_FEATURE_BINS (f1/f3) hoặc 2 (f2/f4) */
  match: { f1: number[]; f2: number[]; f3: number[]; f4: number[] }
  notMatch: { f1: number[]; f2: number[]; f3: number[]; f4: number[] }
}

/** Bin index cho giá trị [0,1] — clamp đầu cuối. */
function binIndex(v: number, bins: number): number {
  if (!Number.isFinite(v)) return 0
  const idx = Math.floor(Math.min(Math.max(v, 0), 0.999999) * bins)
  return Math.min(idx, bins - 1)
}

/**
 * Train NB từ cặp (features, isMatch) — Laplace smoothing λ=1 trên MỌI bin
 * (MATH.pdf §Bayes): P(bin|c) = (count[bin] + 1) / (total + K) với K = số bin.
 * Thuần, không I/O.
 */
export function trainNaiveBayesEntityModel(
  pairs: Array<{ features: EntityPairFeatures; isMatch: boolean }>
): NaiveBayesEntityModel {
  const matchCount = pairs.filter(p => p.isMatch).length
  const negCount = pairs.length - matchCount
  const usable = matchCount >= ENTITY_NB_MIN_PAIRS && negCount > 0 && isEntityNbEnabled()

  const bins = { f1: ENTITY_NB_FEATURE_BINS, f2: 2, f3: ENTITY_NB_FEATURE_BINS, f4: 2 }
  const empty = (k: number) => Array.from({ length: k }, () => 0)

  const counts = {
    match: { f1: empty(bins.f1), f2: empty(bins.f2), f3: empty(bins.f3), f4: empty(bins.f4) },
    notMatch: { f1: empty(bins.f1), f2: empty(bins.f2), f3: empty(bins.f3), f4: empty(bins.f4) },
  }
  for (const p of pairs) {
    const cls = p.isMatch ? counts.match : counts.notMatch
    cls.f1[binIndex(p.features.f1, bins.f1)]++
    cls.f2[p.features.f2]++
    cls.f3[binIndex(p.features.f3, bins.f3)]++
    cls.f4[p.features.f4]++
  }

  const logTable = (countsArr: number[], k: number): number[] => {
    const total = countsArr.reduce((s, v) => s + v, 0)
    // total=0 (class rỗng) → uniform 1/K — chống log(0), giữ neutral
    return countsArr.map(c => Math.log((c + 1) / (total + k)))
  }

  return {
    trainedAt: Date.now(),
    pairCount: matchCount,
    negativeCount: negCount,
    usable,
    match: {
      f1: logTable(counts.match.f1, bins.f1),
      f2: logTable(counts.match.f2, bins.f2),
      f3: logTable(counts.match.f3, bins.f3),
      f4: logTable(counts.match.f4, bins.f4),
    },
    notMatch: {
      f1: logTable(counts.notMatch.f1, bins.f1),
      f2: logTable(counts.notMatch.f2, bins.f2),
      f3: logTable(counts.notMatch.f3, bins.f3),
      f4: logTable(counts.notMatch.f4, bins.f4),
    },
  }
}

/**
 * LLR = log P(f|match) − log P(f|not) trên 4 đặc trưng (thuần).
 * Model chưa usable → trả 0 (neo vùng xám → fuzzy luôn quyết — an toàn).
 */
export function classifyEntityPair(model: NaiveBayesEntityModel, f: EntityPairFeatures): number {
  if (!model.usable) return 0
  const m = model.match
  const n = model.notMatch
  return (
    m.f1[binIndex(f.f1, ENTITY_NB_FEATURE_BINS)] - n.f1[binIndex(f.f1, ENTITY_NB_FEATURE_BINS)]
    + m.f2[f.f2] - n.f2[f.f2]
    + m.f3[binIndex(f.f3, ENTITY_NB_FEATURE_BINS)] - n.f3[binIndex(f.f3, ENTITY_NB_FEATURE_BINS)]
    + m.f4[f.f4] - n.f4[f.f4]
  )
}

/**
 * Kill-switch env ENTITY_NB — 'off' tắt (rollback tức thời, spec §P5-M3);
 * mọi giá trị khác (kể cả unset/rỗng) = BẬT khi đủ dữ liệu. (Quy ước ngược
 * với ADAPTATION_STATS_GATE — mặc định đây là on-khi-đủ-dữ-liệu vì NB chỉ
 * tự kích hoạt sau ngưỡng 100 cặp — chính ngưỡng đó là lớp an toàn chính.)
 */
export function isEntityNbEnabled(): boolean {
  const s = (process.env.ENTITY_NB ?? '').trim().toLowerCase()
  return s !== 'off'
}

/** Cache model trong RAM 10 phút (spec §P5-M3). */
let entityNbCache: { model: NaiveBayesEntityModel | null; expiresAt: number } | null = null

/** Reset cache (test dùng). */
export function resetEntityNbCache(): void {
  entityNbCache = null
}

export interface NbTrainingRow {
  /** entity thô (LocalEntity) */
  entity: EntityFeatureInput
  /** canonical đã ghép đúng (LocalResolvedEntity) — null = chưa resolve */
  matchedCanonical: EntityFeatureInput | null
}

/**
 * Lắp ráp cặp train từ DB rows: positive = (entity, canonical resolved của nó);
 * negative = (entity, canonical KHÁC cùng entityType, tên KHÔNG quá giống
 * (f1 < 0.85 — dưới ngưỡng fuzzy: chắc chắn không phải bản sao bị miss) và
 * không dễ quá khác (f1 ≥ 0.3 — bỏ negative hiển nhiên vô bổ), chọn
 * DETERMINISTIC theo thứ tự canonicalName — không RNG, chạy lại cho cùng kết
 * quả (nguyên tắc reproducibility của dự án).
 */
export function buildNbTrainingPairs(
  rows: NbTrainingRow[],
  allCanonicals: EntityFeatureInput[]
): Array<{ features: EntityPairFeatures; isMatch: boolean }> {
  const pairs: Array<{ features: EntityPairFeatures; isMatch: boolean }> = []
  const sortedCanonicals = [...allCanonicals].sort((a, b) => a.name.localeCompare(b.name))

  for (const row of rows) {
    if (row.matchedCanonical) {
      pairs.push({ features: computeEntityPairFeatures(row.entity, row.matchedCanonical), isMatch: true })
    }
    // Negative: cùng type, f1 ∈ [0.3, 0.85) — deterministic first-match
    const neg = sortedCanonicals.find(c => {
      if (row.matchedCanonical && c.name === row.matchedCanonical.name) return false
      if (c.type.trim().toLowerCase() !== row.entity.type.trim().toLowerCase()) return false
      const f1 = stringSimilarity(row.entity.name.toLowerCase().trim(), c.name.toLowerCase().trim())
      return f1 >= 0.3 && f1 < 0.85
    })
    if (neg) {
      pairs.push({ features: computeEntityPairFeatures(row.entity, neg), isMatch: false })
    }
  }
  return pairs
}

/**
 * Train NB model từ LocalEntity/LocalResolvedEntity (ground truth sẵn có) —
 * cache 10 phút. Trả null khi: kill-switch off / DB lỗi / chưa đủ cặp match
 * (caller giữ nguyên hành vi fuzzy cũ). Fail-open tuyệt đối: lỗi train không
 * được phép làm hỏng pipeline resolve.
 */
export async function loadNaiveBayesModel(): Promise<NaiveBayesEntityModel | null> {
  if (!isEntityNbEnabled()) return null
  if (entityNbCache && Date.now() < entityNbCache.expiresAt) return entityNbCache.model

  let model: NaiveBayesEntityModel | null = null
  try {
    const [entityRows, canonicalRows] = await Promise.all([
      db.localEntity.findMany({
        where: { resolvedEntityId: { not: null } },
        select: { entityName: true, entityType: true, description: true, domain: true, resolvedEntityId: true },
        take: ENTITY_NB_MAX_ROWS,
      }),
      db.localResolvedEntity.findMany({
        select: { id: true, canonicalName: true, entityType: true, description: true, domains: true },
        take: ENTITY_NB_MAX_ROWS,
      }),
    ])

    const parseDomains = (s: string | null): string[] => {
      if (!s) return []
      try {
        const v = JSON.parse(s)
        return Array.isArray(v) ? v.map(String) : []
      } catch {
        return []
      }
    }

    const canonicalById = new Map(
      canonicalRows.map(c => [
        c.id,
        { name: c.canonicalName, type: c.entityType, description: c.description ?? '', domains: parseDomains(c.domains) },
      ])
    )

    const trainingRows: NbTrainingRow[] = entityRows
      .map(e => ({
        entity: {
          name: e.entityName,
          type: e.entityType,
          description: e.description ?? '',
          domains: e.domain ? [e.domain] : [],
        },
        matchedCanonical: e.resolvedEntityId ? canonicalById.get(e.resolvedEntityId) ?? null : null,
      }))
      .filter(r => r.matchedCanonical !== null)

    const allCanonicals: EntityFeatureInput[] = [...canonicalById.values()]
    const pairs = buildNbTrainingPairs(trainingRows, allCanonicals)
    model = trainNaiveBayesEntityModel(pairs)
    if (!model.usable) model = null // chưa đủ 100 cặp → null = fuzzy cũ

    console.log(
      `[EntityResolver] P5-M3 NB model: ${model ? `TRAINED (pairs=${model.pairCount}, negatives=${model.negativeCount})` : 'chưa đủ dữ liệu — giữ fuzzy cũ'} từ ${entityRows.length} entity resolved / ${canonicalRows.length} canonical`
    )
  } catch (err) {
    // Fail-open: DB lỗi → null → fuzzy cũ
    console.warn('[EntityResolver] loadNaiveBayesModel failed (fail-open → fuzzy cũ):', err instanceof Error ? err.message : String(err))
    model = null
  }

  entityNbCache = { model, expiresAt: Date.now() + ENTITY_NB_CACHE_MS }
  return model
}


/** Tùy chọn P5-M3 cho resolveEntities — nbModel null/undefined = fuzzy cũ thuần. */
export interface ResolveOptions {
  /** Mô hình NB đã train (loadNaiveBayesModel — cache 10 phút); chỉ dùng khi usable */
  nbModel?: NaiveBayesEntityModel | null
}

/**
 * Bước 2 của resolve flow — P5-M3: NB quyết trong vùng tin cậy, fuzzy fallback
 * vùng xám. Khi nbModel null/không usable → NGUYÊN trạng thái fuzzy cũ (đối
 * chiếu bằng test — dưới 100 cặp kết quả phải y hệt bản cũ).
 *
 * Luật quyết với NB usable (τ = ENTITY_NB_TAU, vùng xám = ENTITY_NB_GRAY_ZONE):
 *   LLR > τ ∧ LLR ≥ +GRAY  → merge (method 'nb', similarity = f1)
 *   LLR ≤ τ ∧ LLR ≤ −GRAY  → KHÔNG merge (NB chặn — fuzzy cũng không được phép)
 *   |LLR| < GRAY (vùng xám) → luật fuzzy cũ quyết (cùng type + similarity > 0.85)
 */
function nbThenFuzzyMatchResolution(
  resolved: Map<string, ResolvedEntity>,
  duplicates: DuplicatePair[],
  nbModel: NaiveBayesEntityModel | null,
  threshold = 0.85
): {
  resolved: Map<string, ResolvedEntity>
  duplicates: DuplicatePair[]
} {
  const nbUsable = nbModel !== null && nbModel.usable && isEntityNbEnabled()
  const entries = Array.from(resolved.entries())
  const toMerge: Array<{ source: string; target: string; similarity: number; method: 'fuzzy' | 'nb' }> = []
  const processed = new Set<string>()

  // Compare all pairs
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [nameA, entityA] = entries[i]
      const [nameB, entityB] = entries[j]

      // Skip already processed
      if (processed.has(nameA) || processed.has(nameB)) continue

      if (nbUsable) {
        // NB nhìn cặp bằng đặc trưng đầy đủ (f2 type-hợp-khác học từ dữ liệu —
        // không lọc trước cùng type như fuzzy); quyết vùng tin cậy thì chốt,
        // vùng xám rơi xuống luật fuzzy bên dưới (kèm điều kiện cùng type gốc)
        const features = computeEntityPairFeatures(
          { name: entityA.canonicalName, type: entityA.entityType, description: entityA.description, domains: entityA.domains },
          { name: entityB.canonicalName, type: entityB.entityType, description: entityB.description, domains: entityB.domains }
        )
        const llr = classifyEntityPair(nbModel!, features)
        if (llr > ENTITY_NB_TAU && llr >= ENTITY_NB_GRAY_ZONE) {
          // NB match — merge (giữ quy ước fuzzy: tên ngắn hòa vào tên dài)
          const [source, target] = nameA.length >= nameB.length ? [nameB, nameA] : [nameA, nameB]
          toMerge.push({ source, target, similarity: features.f1, method: 'nb' })
          processed.add(source)
          continue
        }
        if (llr <= ENTITY_NB_TAU && llr <= -ENTITY_NB_GRAY_ZONE) {
          // NB chặn — cặp này KHÔNG được merge dù fuzzy muốn (llr ngoài vùng xám)
          continue
        }
        // vùng xám → fuzzy fallback (không continue — rơi xuống dưới)
      }

      // Fuzzy fallback (luật cũ) — same entity type + similarity > threshold
      if (entityA.entityType !== entityB.entityType) continue

      const normalizedA = nameA.toLowerCase().trim()
      const normalizedB = nameB.toLowerCase().trim()
      const similarity = stringSimilarity(normalizedA, normalizedB)

      if (similarity > threshold) {
        // Merge shorter name into longer name (prefer more descriptive)
        const [source, target] = nameA.length >= nameB.length ? [nameB, nameA] : [nameA, nameB]
        toMerge.push({ source, target, similarity, method: 'fuzzy' })
        processed.add(source)
      }
    }
  }

  // Perform merges (giữ nguyên cơ chế merge của fuzzyMatchResolution gốc)
  for (const { source, target, similarity, method } of toMerge) {
    const sourceEntity = resolved.get(source)
    const targetEntity = resolved.get(target)

    if (sourceEntity && targetEntity) {
      // Merge source into target
      targetEntity.occurrenceCount += sourceEntity.occurrenceCount
      targetEntity.avgConfidence = Math.max(targetEntity.avgConfidence, sourceEntity.avgConfidence)
      targetEntity.sourceNames.push(...sourceEntity.sourceNames)

      // Merge properties
      for (const [key, value] of Object.entries(sourceEntity.properties)) {
        if (!(key in targetEntity.properties)) {
          targetEntity.properties[key] = value
        }
      }

      // Merge descriptions
      if (sourceEntity.description.length > targetEntity.description.length) {
        targetEntity.description = sourceEntity.description
      }

      // Merge domains
      for (const domain of sourceEntity.domains) {
        if (!targetEntity.domains.includes(domain)) {
          targetEntity.domains.push(domain)
        }
      }

      // Remove source from resolved
      resolved.delete(source)

      duplicates.push({
        merged: source,
        into: target,
        method,
        similarity,
      })
    }
  }

  return { resolved, duplicates }
}

/**
 * Resolve and deduplicate entities
 */
export function resolveEntities(entities: ExtractedEntity[], options?: ResolveOptions): ResolutionResult {
  const totalInput = entities.length

  // Step 1: Exact match
  const { resolved, duplicates: exactDuplicates } = exactMatchResolution(entities)
  const afterExactMatch = resolved.size

  // Step 2: P5-M3 — NB (khi model usable) quyết vùng tin cậy, fuzzy fallback
  // vùng xám; không model → đúng hành vi fuzzy cũ tuyệt đối
  const { resolved: finalResolved, duplicates: fuzzyDuplicates } = nbThenFuzzyMatchResolution(
    resolved,
    exactDuplicates,
    options?.nbModel ?? null
  )
  const afterFuzzyMatch = finalResolved.size

  // Step 3: LLM-based match (skipped for now - high cost)
  // Could be implemented later as an optional step

  const finalEntities = Array.from(finalResolved.values())

  return {
    resolved: finalEntities,
    duplicates: [...exactDuplicates, ...fuzzyDuplicates],
    stats: {
      totalInput,
      afterExactMatch,
      afterFuzzyMatch,
      finalCount: finalEntities.length,
    },
  }
}

/**
 * Update relationship references after entity resolution
 */
export function updateRelationshipReferences(
  relationships: Array<{ source: string; target: string; [key: string]: unknown }>,
  duplicates: DuplicatePair[]
): Array<{ source: string; target: string; [key: string]: unknown }> {
  // Build mapping from merged names to canonical names
  const mergeMap = new Map<string, string>()
  for (const dup of duplicates) {
    mergeMap.set(dup.merged.toLowerCase().trim(), dup.into)
    // Also map the canonical name itself
    if (!mergeMap.has(dup.into.toLowerCase().trim())) {
      mergeMap.set(dup.into.toLowerCase().trim(), dup.into)
    }
  }

  return relationships.map((rel) => ({
    ...rel,
    source: mergeMap.get(rel.source.toLowerCase().trim()) || rel.source,
    target: mergeMap.get(rel.target.toLowerCase().trim()) || rel.target,
  }))
}

// ==================== EMBEDDING-BASED ENTITY RESOLUTION (Prop 2.5) ====================

/**
 * Threshold for embedding-based entity merge.
 *
 * Raw cosine similarity between two entity embedding vectors must exceed this
 * for them to be considered the same entity. Tuned to 0.85 per Prop 2.5 spec
 * (matches the pre-existing Levenshtein fuzzy threshold for parity).
 *
 * Note: Neo4j's vector.similarity.cosine() scalar function returns the normalized
 * form (1 + raw_cosine) / 2 ∈ [0, 1]. So when querying, we compare the Neo4j
 * returned score against NEO4J_NORMALIZED_THRESHOLD = 0.925 (= (1 + 0.85) / 2).
 */
export const ENTITY_EMBEDDING_RAW_COSINE_THRESHOLD = 0.85
export const ENTITY_EMBEDDING_NEO4J_SCORE_THRESHOLD = (1 + ENTITY_EMBEDDING_RAW_COSINE_THRESHOLD) / 2 // 0.925

/** Top-K nearest candidates to fetch from Neo4j before applying the score threshold. */
const ENTITY_EMBEDDING_TOP_K = 5

/**
 * Tạo entity id deterministic `global__<slug(name)>__<slug(type)>`.
 * Copy NGUYÊN format từ ingestion process route (~dòng 1590) để entity cùng
 * (name, type) từ chat-writeback và PDF-ingestion MERGE vào CÙNG 1 node —
 * idempotent, hết cảnh mỗi lượt chat đẻ node UUID mới (kg-arch-a: 265 node trùng).
 * slug: trim + lowercase + thay mọi ký tự ngoài [a-z0-9] bằng `_`
 * (entity types chuẩn đều 1 từ → trùng khớp byte với process route).
 */
export function globalEntityId(name: string, type: string): string {
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')
  return `global__${slug(name)}__${slug(type)}`
}

/**
 * FIX kg-arch-a — exact-name lookup: lớp fallback BÊN DƯỚI embedding-dedup,
 * chạy TRƯỚC khi tạo node mới. Bắt các node trùng tên nhưng KHÔNG có embedding
 * (node do ingestion tạo, embedding fail, Neo4j lỗi...) → reuse id thay vì tạo mới.
 *
 * Loại node Document "thật" (có n.status) trừ khi cần tìm entity type Document —
 * tránh MERGE (label, id) của upsertEntitiesBatch bám nhầm id node Document.
 * Ưu tiên: cùng label → id global__ (node canonical của ingestion) → id ổn định.
 *
 * Fail-open: lỗi Neo4j → trả null (giữ hành vi cũ — tạo id mới).
 */
async function findExactNameMatch(
  name: string,
  preferredLabel: EntityLabel
): Promise<{ id: string; name: string; label: string } | null> {
  try {
    const hits = await readCypher<{ id: string; nodeName: string; labels: string[] }>(
      `MATCH (n)
       WHERE toLower(n.name) = toLower($name)
         AND n.id IS NOT NULL
         AND ($prefLabel = 'Document' OR n.status IS NULL)
       WITH n,
            CASE WHEN $prefLabel IN labels(n) THEN 0 ELSE 1 END AS labelPrio,
            CASE WHEN n.id STARTS WITH 'global__' THEN 0 ELSE 1 END AS idPrio
       ORDER BY labelPrio, idPrio, n.id
       RETURN n.id AS id, n.name AS nodeName, labels(n) AS labels
       LIMIT 1`,
      { name, prefLabel: preferredLabel }
    )
    if (hits.length === 0) return null
    const labels = hits[0].labels ?? []
    // Label để caller align entity_type: ưu tiên label đang tìm, rồi label chuẩn
    const label = labels.includes(preferredLabel)
      ? preferredLabel
      : labels.find(l => (ENTITY_LABELS as readonly string[]).includes(l)) ?? labels[0] ?? preferredLabel
    return { id: hits[0].id, name: hits[0].nodeName ?? name, label }
  } catch (err) {
    console.warn(
      `[EntityResolver] Exact-name lookup failed for "${name}" (fail-open):`,
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

export interface ResolveByEmbeddingInput {
  name: string
  description: string
  /** Entity type label — must be in ENTITY_LABELS. Falls back to 'Concept' if invalid. */
  type: string
}

export interface ResolveByEmbeddingResult {
  /**
   * Resolved entity ID: id node Neo4j đang có (merge) hoặc id deterministic
   * `global__<name>__<type>` (node mới — MERGE idempotent mỗi lượt chat,
   * fix kg-arch-a: hết cảnh mỗi turn đẻ node UUID trùng khái niệm).
   */
  id: string
  /** True if no match was found and a new id was generated; false if merged into existing. */
  isNew: boolean
  /** Embedding vector for the entity. Empty array if all embedding providers failed. */
  embedding: number[]
  /**
   * Method used for resolution:
   *   - 'embedding' — cosine ≥ threshold (raw 0.85)
   *   - 'exact'     — fallback exact-name lookup (bắt node trùng tên không có embedding)
   *   - 'none'      — embedding gen failed + không exact-match (id deterministic mới)
   */
  method: 'embedding' | 'exact' | 'none'
  /** Matched candidate details (only present when isNew=false). */
  matched?: { id: string; name: string; score: number; label?: string }
}

/**
 * Resolve an entity by name + description using embedding similarity.
 *
 * Flow:
 *   1. Sanitize label (ENTITY_LABELS, fallback 'Concept').
 *   2. Generate embedding for `${name}: ${description}` via generateEmbedding().
 *   3. Length-check (P0.1 — skip if all providers failed, returns empty array).
 *   4. Query Neo4j for the nearest entity of the same label using
 *      vector.similarity.cosine() scalar function. This is a linear scan but
 *      Neo4j entity nodes per label are typically <10K so it's fast enough.
 *      The db.index.vector.queryNodes procedure (HNSW-accelerated) is the
 *      alternative — but it requires the index to be ONLINE which is async
 *      after CREATE VECTOR INDEX. The scalar function works without an index.
 *   5. If top candidate score > NEO4J_NORMALIZED_THRESHOLD → merge (return its id).
 *   6. Else exact-name lookup (fallback) → node trùng tên (kể cả không
 *      embedding) → reuse id. Chỉ khi hoàn toàn không có node trùng tên mới
 *      trả id deterministic `global__<name>__<type>` (node mới).
 *
 * Failures (embedding API down, Neo4j unreachable) → returns isNew=true with
 * empty embedding array. The caller's writeback pipeline skips the embedding
 * write (matches P0.1 contract from Phase 6 SMOLAB).
 */
export async function resolveEntityByNameAndEmbedding(
  entity: ResolveByEmbeddingInput
): Promise<ResolveByEmbeddingResult> {
  // Step 1: Sanitize label — must be in ENTITY_LABELS (Neo4j schema constraint)
  const label: EntityLabel = (ENTITY_LABELS as readonly string[]).includes(entity.type)
    ? (entity.type as EntityLabel)
    : 'Concept'

  // Step 2: Generate embedding for entity name + description
  const text = `${entity.name}: ${entity.description}`.trim()
  const { vector, model } = await generateEmbedding(text)

  // Step 3: P0.1 — skip if embedding generation failed (no pseudo-hash fallback).
  // FIX kg-arch-a: vẫn thử exact-name lookup trước khi rơi xuống id mới —
  // node trùng tên (không embedding) được reuse thay vì đẻ node UUID mới.
  if (vector.length === 0 || model === 'none') {
    const exact = await findExactNameMatch(entity.name, label)
    if (exact) {
      return {
        id: exact.id,
        isNew: false,
        embedding: [] as number[],
        method: 'exact',
        matched: { id: exact.id, name: exact.name, score: 1, label: exact.label },
      }
    }
    return {
      // Id deterministic thay randomUUID — lượt sau MERGE vào đúng node này
      id: globalEntityId(entity.name, label),
      isNew: true,
      embedding: [] as number[],
      method: 'none',
    }
  }

  // Step 4: Query Neo4j for nearest entities of the same label.
  // vector.similarity.cosine() returns the normalized (1 + raw_cos) / 2 ∈ [0, 1].
  // We compare against NEO4J_SCORE_THRESHOLD (= 0.925 for raw_cos 0.85).
  //
  // LIMIT requires an integer — JS numbers are doubles so 5 becomes 5.0 in transit.
  // Wrapping in toInteger() coerces to the integer form Neo4j expects.
  let candidates: Array<{ id: string; name: string; score: number }> = []
  try {
    candidates = await readCypher<{ id: string; name: string; score: number }>(
      `MATCH (n:${label})
       WHERE n.embedding IS NOT NULL
       WITH n, vector.similarity.cosine(n.embedding, $vec) AS score
       WHERE score >= $threshold
       RETURN n.id AS id, n.name AS name, score
       ORDER BY score DESC
       LIMIT toInteger($limit)`,
      {
        vec: vector,
        threshold: ENTITY_EMBEDDING_NEO4J_SCORE_THRESHOLD,
        limit: ENTITY_EMBEDDING_TOP_K,
      }
    )
  } catch (err) {
    // Neo4j connection issues / transient errors — fall through to "new entity"
    // path so writeback proceeds (entity will be created with the embedding
    // already in payload, so next query will find it via vector search).
    console.warn(
      `[EntityResolver] vector.similarity.cosine query failed for label=${label}:`,
      err instanceof Error ? err.message : String(err)
    )
  }

  // Step 5: Merge into top candidate if found
  if (candidates.length > 0) {
    const top = candidates[0]
    return {
      id: top.id,
      isNew: false,
      embedding: vector,
      method: 'embedding',
      matched: { id: top.id, name: top.name, score: top.score, label },
    }
  }

  // Step 6: FIX kg-arch-a — exact-name fallback (bên DƯỚI embedding-dedup,
  // KHÔNG thay thế): node trùng tên nhưng không embedding (vd node ingestion
  // global__*) → reuse id để caller MERGE vào node cũ.
  const exact = await findExactNameMatch(entity.name, label)
  if (exact) {
    return {
      id: exact.id,
      isNew: false,
      embedding: vector,
      method: 'exact',
      matched: { id: exact.id, name: exact.name, score: 1, label: exact.label },
    }
  }

  return {
    // Id deterministic thay randomUUID — MERGE idempotent mỗi lượt chat
    id: globalEntityId(entity.name, label),
    isNew: true,
    embedding: vector,
    method: 'embedding',
  }
}
