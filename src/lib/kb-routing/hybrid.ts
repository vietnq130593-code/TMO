/**
 * Phase 4 SMOLAB Proposal 3.7 — Hybrid retrieval: BM25 + Reciprocal Rank Fusion.
 *
 * Dense (vector) retrieval misses exact keyword matches — error codes,
 * identifiers, function names ("TypeError", "GPT-4", "npm install"). BM25 is
 * the classic sparse/lexical complement: it rewards exact term overlap with
 * IDF weighting. We fuse both rankings with Reciprocal Rank Fusion (RRF),
 * which needs no score normalization (rank-based — robust to different score
 * distributions).
 *
 * In-process implementation over the DENSE CANDIDATE SET only:
 *   - Corpus for BM25 = the candidates returned by the Qdrant query itself
 *     (topK×4 items). No separate sparse index, NO Qdrant collection
 *     migration/recreation (the spec's collection-recreate approach would
 *     destroy the existing 1045 chunks — deliberately avoided; we have R2
 *     backups but don't rely on them).
 *   - 1-gram terms: lowercase + split on non-alphanumeric, keeping numbers —
 *     important for exact matches on "GPT-4", "404", "npm install".
 *
 * Algorithm:
 *   1. BM25 (k1=1.5, b=0.75) of query terms against each candidate text,
 *      corpus = the candidates themselves.
 *   2. dense_rank = rank by dense score (1 = best), bm25_rank = rank by BM25.
 *   3. RRF fuse: rrf = 1/(60 + dense_rank) + 1/(60 + bm25_rank).
 *   4. Sort by rrf desc. The fused order is what callers consume; .score is
 *      replaced with the rrf value min-max normalized to [0, 1] (dense scores
 *      and rrf live on different scales — downstream confidence calibration
 *      expects 0-1, so we normalize; ordering is identical either way).
 *
 * Pure function — no DB, no LLM, no side effects.
 */

export interface HybridCandidate {
  id: string
  text: string
  /** Dense similarity score from the vector search (higher = better). */
  score: number
}

/** BM25 parameters (standard defaults). */
const BM25_K1 = 1.5
const BM25_B = 0.75

/** RRF smoothing constant (standard value from the original paper). */
const RRF_K = 60

/**
 * Tokenize text for BM25: lowercase + split on non-alphanumeric.
 * Numbers are kept — critical for exact-match on error codes / identifiers
 * ("TypeError", "GPT-4" → ["gpt", "4"], "npm install" → ["npm", "install"]).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

/**
 * Hybrid-fuse dense candidates with in-process BM25 + RRF.
 *
 * @param query      Raw user query string.
 * @param candidates Dense-search candidates (order = dense rank, best first).
 * @returns New array sorted by fused RRF score (best first). Original
 *          candidates are NOT mutated; returned items are shallow copies with
 *          .score replaced by the normalized RRF fusion score in [0, 1].
 *          If candidates.length <= 1, returns them unchanged (in a new array).
 */
export function hybridFuse(query: string, candidates: HybridCandidate[]): HybridCandidate[] {
  if (candidates.length <= 1) {
    return [...candidates]
  }

  // ---- 1. BM25 scores over the candidate corpus ----
  const queryTerms = tokenize(query)
  const docs = candidates.map((c) => tokenize(c.text))

  // Document frequency per query term (in how many candidate docs the term appears).
  const docFreq = new Map<string, number>()
  for (const term of queryTerms) {
    if (docFreq.has(term)) continue // count each query term once
    let df = 0
    for (const doc of docs) {
      if (doc.includes(term)) df++
    }
    docFreq.set(term, df)
  }

  const N = candidates.length
  const avgDocLen = docs.reduce((sum, d) => sum + d.length, 0) / N || 1

  const bm25Scores = docs.map((doc) => {
    // Term frequency for this doc.
    const tf = new Map<string, number>()
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1)

    let score = 0
    for (const term of queryTerms) {
      const f = tf.get(term) ?? 0
      if (f === 0) continue
      const df = docFreq.get(term) ?? 0
      // IDF (BM25 variant, always positive for df <= N).
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      const norm = f * (BM25_K1 + 1) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / avgDocLen)))
      score += idf * norm
    }
    return score
  })

  // ---- 2. Ranks (1-based; stable — ties resolved by incoming dense order) ----
  const denseRank = rankByScore(candidates.map((c) => c.score))
  const bm25Rank = rankByScore(bm25Scores)

  // ---- 3. RRF fusion ----
  const rrf = candidates.map(
    (_, i) => 1 / (RRF_K + denseRank[i]) + 1 / (RRF_K + bm25Rank[i])
  )

  // ---- 4. Normalize RRF to [0, 1] + sort by fused score ----
  let min = Infinity
  let max = -Infinity
  for (const v of rrf) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min

  const fused = candidates.map((c, i) => ({
    candidate: c,
    fusedScore: span > 0 ? (rrf[i] - min) / span : 1, // degenerate: all-equal rrf → 1
    denseScore: c.score,
  }))

  // Fused score desc; ties resolved by the incoming dense order (stable).
  fused.sort((a, b) => b.fusedScore - a.fusedScore || b.denseScore - a.denseScore)

  return fused.map((f) => ({
    id: f.candidate.id,
    text: f.candidate.text,
    score: f.fusedScore,
  }))
}

/**
 * Compute 1-based ranks from scores (higher score = better rank).
 * Stable: equal scores get equal ranks via competition ranking (1,1,3,...) —
 * deterministic because we iterate in incoming order.
 */
function rankByScore(scores: number[]): number[] {
  const n = scores.length
  // Sort indices by score desc (stable via index tiebreak).
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => scores[b] - scores[a] || a - b
  )
  const ranks = new Array<number>(n).fill(0)
  let currentRank = 1
  for (let pos = 0; pos < n; pos++) {
    if (pos > 0 && scores[order[pos]] !== scores[order[pos - 1]]) {
      currentRank = pos + 1 // competition ranking
    }
    ranks[order[pos]] = currentRank
  }
  return ranks
}
