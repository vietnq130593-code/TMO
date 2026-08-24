/**
 * Phase 4 SMOLAB Proposal 3.8 — Maximal Marginal Relevance (MMR) rerank.
 *
 * MMR balances relevance vs. diversity when selecting the final top-K chunks:
 *
 *   mmr(c) = λ·sim(query, c) − (1−λ)·max_{s ∈ selected} sim(c, s)
 *
 * At each step we greedily pick the candidate with the highest MMR score, add it
 * to the selected set, and repeat until topK is reached. λ (lambda) controls the
 * trade-off: λ=1 → pure relevance (identical to dense order), λ=0 → pure
 * diversity. Default λ=0.7 is relevance-prioritized with a mild diversity
 * penalty, per Prop 3.8 spec.
 *
 * KEY OPTIMIZATION vs spec: we do NOT re-embed chunk texts (no LLM/embedding
 * API calls). Qdrant returns the stored vectors when asked (`with_vector: true`
 * on qdrant.query), so searchChunks passes those pre-fetched vectors here and
 * MMR is a pure, fast, offline computation.
 *
 * Graceful degradation:
 *   - If NO candidate carries a vector, return candidates.slice(0, topK)
 *     unchanged (original dense order preserved).
 *   - Candidates WITH vectors are ranked first (MMR-selected); candidates
 *     WITHOUT vectors are appended afterward in their original order (only if
 *     the topK budget is not yet exhausted).
 *
 * Pure function — no DB, no LLM, no side effects.
 */

export interface MmrCandidate {
  id: string
  text: string
  /** Dense similarity score from the vector search (cosine, higher = better). */
  score: number
  /** Pre-fetched embedding vector from Qdrant (with_vector: true). */
  vector?: number[]
}

/** Cosine similarity between two equal-length vectors. Returns 0 on degenerate input. */
function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * MMR-select the top-K candidates for a query vector.
 *
 * Generic over T so caller-side metadata (documentId, source, ...) survives
 * the selection untouched.
 *
 * @param queryVector Embedding of the user query (same space as candidate vectors).
 * @param candidates  Scored candidates from the dense search (may carry vectors).
 * @param topK        Number of results to select.
 * @param lambda      Relevance/diversity trade-off (default 0.7 — relevance-prioritized).
 * @returns Candidates reordered by MMR (length ≤ topK). Original objects are
 *          returned (not cloned) — callers can rely on reference identity.
 */
export function mmrSelect<T extends MmrCandidate>(
  queryVector: number[],
  candidates: T[],
  topK: number,
  lambda = 0.7
): T[] {
  if (topK <= 0) return []
  if (candidates.length <= 1) return candidates.slice(0, topK)

  const withVectors = candidates.filter(c => Array.isArray(c.vector) && c.vector!.length > 0)
  const withoutVectors = candidates.filter(c => !Array.isArray(c.vector) || !c.vector || c.vector.length === 0)

  // Graceful: no vectors anywhere → cannot compute MMR, keep dense order.
  if (withVectors.length === 0) {
    return candidates.slice(0, topK)
  }

  const selected: T[] = []
  const remaining = [...withVectors]

  // Pre-compute query similarity for every candidate (used at every step).
  const querySim = new Map<string, number>()
  for (const c of remaining) {
    querySim.set(c.id, cosineSim(queryVector, c.vector!))
  }

  // First pick: highest query similarity (pure relevance — no selected set yet).
  // (If the query vector is degenerate/zero-length, cosineSim returns 0 for all —
  // then we fall back to the first candidate in dense order.)
  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]
      const relevance = querySim.get(cand.id) ?? 0
      let maxSimToSelected = 0
      for (const sel of selected) {
        const sim = cosineSim(cand.vector!, sel.vector!)
        if (sim > maxSimToSelected) maxSimToSelected = sim
      }
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected
      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0])
  }

  // Vector-less candidates keep their original relative order at the tail —
  // only appended if the topK budget still has room (it usually won't).
  for (const c of withoutVectors) {
    if (selected.length >= topK) break
    selected.push(c)
  }

  return selected
}
