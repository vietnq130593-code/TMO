/**
 * Phase 4 SMOLAB Proposal 3.6 — Cross-encoder reranker client.
 *
 * A cross-encoder (query, document → relevance score) is the strongest
 * reranker available: unlike bi-encoder cosine similarity it reads the query
 * and the document TOGETHER, catching fine-grained term interactions. This
 * module is a thin HTTP client for any rerank-protocol-compatible endpoint
 * (e.g. bge-reranker-v2-m3 served via a mini-service).
 *
 * PROTOCOL (rerank-protocol compatible):
 *   POST {RERANKER_ENDPOINT}
 *   Body:     { "query": string, "documents": string[] }
 *   Response: { "results": [{ "index": number, "score": number }, ...] }
 *   `index` refers to the position in the input documents array;
 *   `score` higher = more relevant.
 *
 * HOSTING (NOT built in this task — deliberately deferred):
 *   The reference model is BAAI/bge-reranker-v2-m3 (~560MB download — too heavy
 *   to pull during this task). To host one later:
 *
 *     mini-services/reranker/
 *       package.json        (deps: @xenova/transformers, express or Bun.serve)
 *       server.ts:
 *         import { pipeline } from '@xenova/transformers'
 *         const reranker = await pipeline('text-classification',
 *                                        'Xenova/bge-reranker-v2-m3')
 *         // POST /rerank { query, documents } → reranker(query, doc) pairs,
 *         // map to { index, score }, sort desc, return { results }
 *       Run on port 8080 (or set RERANKER_ENDPOINT in .env).
 *
 *   Then flip ENABLE_RERANKER=true in .env — searchChunks in kb-access.ts
 *   will call rerankTopK() and reorder its top candidates.
 *
 * GRACEFUL FALLBACK: on ANY failure — connection refused, 3s timeout,
 * non-200 status, malformed JSON, missing/short results array — return null.
 * The caller keeps its current (hybrid+MMR) order. Reranking must never make
 * retrieval worse than its absence, and must never block the pipeline.
 */

const RERANKER_ENDPOINT = process.env.RERANKER_ENDPOINT || 'http://localhost:8080/rerank'

/** Hard timeout for the rerank HTTP call — retrieval must stay snappy. */
const RERANKER_TIMEOUT_MS = 3000

/**
 * Rerank documents for a query via the external cross-encoder service.
 *
 * @param query User query string.
 * @param docs  Candidate document texts (order = current pipeline order).
 * @returns Array of ORIGINAL indices sorted by rerank score (best first),
 *          covering all documents (or fewer if the service truncated — the
 *          caller should treat the returned prefix as the reranked head).
 *          Returns null on ANY failure — caller keeps the current order.
 */
export async function rerankTopK(query: string, docs: string[]): Promise<number[] | null> {
  if (docs.length === 0) return []

  try {
    const response = await fetch(RERANKER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, documents: docs }),
      signal: AbortSignal.timeout(RERANKER_TIMEOUT_MS),
    })

    if (!response.ok) {
      console.warn(
        `[Reranker] Service returned HTTP ${response.status} — keeping current order (flag ENABLE_RERANKER can be set to false to silence this)`
      )
      return null
    }

    const data = (await response.json()) as {
      results?: Array<{ index?: unknown; score?: unknown }>
    }

    if (!Array.isArray(data.results) || data.results.length === 0) {
      console.warn('[Reranker] Malformed response (missing/empty results array) — keeping current order')
      return null
    }

    // Map results → original indices with numeric scores; skip malformed entries.
    const scored: Array<{ index: number; score: number }> = []
    for (const r of data.results) {
      const idx = typeof r?.index === 'number' ? r.index : Number(r?.index)
      const score = typeof r?.score === 'number' ? r.score : Number(r?.score)
      if (!Number.isInteger(idx) || idx < 0 || idx >= docs.length || !Number.isFinite(score)) {
        continue
      }
      scored.push({ index: idx, score })
    }

    if (scored.length === 0) {
      console.warn('[Reranker] Response had no usable (index, score) entries — keeping current order')
      return null
    }

    // Sort by rerank score desc (stable — service order breaks ties).
    scored.sort((a, b) => b.score - a.score)
    return scored.map((s) => s.index)
  } catch (err) {
    // Connection refused / timeout / DNS failure / bad JSON (json() throws) —
    // all land here. Single warn line, then the caller proceeds unchanged.
    console.warn(
      '[Reranker] Call failed — keeping current order:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}
