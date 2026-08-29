/**
 * Entity Resolver - Entity resolution and deduplication
 * 
 * Step 1: Exact match (case-insensitive, trim whitespace) → merge immediately
 * Step 2: Fuzzy match using Levenshtein distance (threshold: similarity > 0.85) → merge
 * Step 3: LLM-based match for ambiguous cases (optional, high cost)
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
  method: 'exact' | 'fuzzy' | 'llm'
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

// ==================== FUZZY MATCH ====================

/**
 * Step 2: Fuzzy match using Levenshtein distance (threshold: similarity > 0.85)
 */
function fuzzyMatchResolution(
  resolved: Map<string, ResolvedEntity>,
  duplicates: DuplicatePair[],
  threshold = 0.85
): {
  resolved: Map<string, ResolvedEntity>
  duplicates: DuplicatePair[]
} {
  const entries = Array.from(resolved.entries())
  const toMerge: Array<{ source: string; target: string; similarity: number }> = []
  const processed = new Set<string>()

  // Compare all pairs
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [nameA, entityA] = entries[i]
      const [nameB, entityB] = entries[j]

      // Skip if different entity types (except RELATED_TO situations)
      if (entityA.entityType !== entityB.entityType) continue

      // Skip already processed
      if (processed.has(nameA) || processed.has(nameB)) continue

      const normalizedA = nameA.toLowerCase().trim()
      const normalizedB = nameB.toLowerCase().trim()
      const similarity = stringSimilarity(normalizedA, normalizedB)

      if (similarity > threshold) {
        // Merge shorter name into longer name (prefer more descriptive)
        const [source, target] = nameA.length >= nameB.length ? [nameB, nameA] : [nameA, nameB]
        toMerge.push({ source, target, similarity })
        processed.add(source)
      }
    }
  }

  // Perform merges
  for (const { source, target, similarity } of toMerge) {
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
        method: 'fuzzy',
        similarity,
      })
    }
  }

  return { resolved, duplicates }
}

// ==================== MAIN RESOLUTION ====================

/**
 * Resolve and deduplicate entities
 */
export function resolveEntities(entities: ExtractedEntity[]): ResolutionResult {
  const totalInput = entities.length

  // Step 1: Exact match
  const { resolved, duplicates: exactDuplicates } = exactMatchResolution(entities)
  const afterExactMatch = resolved.size

  // Step 2: Fuzzy match
  const { resolved: finalResolved, duplicates: fuzzyDuplicates } = fuzzyMatchResolution(resolved, exactDuplicates)
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
