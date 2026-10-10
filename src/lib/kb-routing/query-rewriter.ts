/**
 * Phase 4 SMOLAB Proposal 3.9 — Query rewriting + HyDE
 * (Hypothetical Document Embeddings).
 *
 * Problem: multi-turn chat queries like "What about its performance?" are
 * useless as retrieval keys — pronouns dangle, the vector search drifts, BM25
 * finds nothing. Fix in 3 LLM-assisted steps:
 *
 *   1. REWRITE   — resolve pronouns/context using the last 2 conversation
 *                  turns → a self-contained query (skipped when the query is
 *                  already self-contained AND there is no history — saves one
 *                  LLM call for the common single-turn case).
 *   2. HyDE      — generate a 3-5 sentence HYPOTHETICAL ANSWER to the rewritten
 *                  query and embed THAT. A hypothetical answer lives in the
 *                  same lexical/semantic space as the stored KB chunks
 *                  (answer ↔ answer), so it often matches better than the
 *                  raw question vector (question ↔ answer asymmetry).
 *   3. EXPANSION — up to 3 paraphrases for future multi-query retrieval.
 *
 * Cost: up to 3 LLM calls (+1-2s latency per query) → callers must gate on the
 * ENABLE_QUERY_REWRITE feature flag (this module does NOT check the flag
 * itself, so it stays unit-testable + reusable — see the chat route wiring).
 *
 * Latency mitigations:
 *   - In-memory LRU cache (200 entries, 10-min sliding TTL) keyed by
 *     hash(query + '|' + last2TurnContents) — repeated asks are free.
 *   - LLM calls 2+3 run in PARALLEL (they both depend only on the rewritten
 *     query), alongside the query embedding.
 *
 * Failure contract: rewriteQuery() returns null on ANY failure (LLM down,
 * embedding down, empty HyDE). Callers fall back to the plain query —
 * retrieval never breaks because of this module.
 */

import { callUtilityLLM } from '@/lib/llm'
import { generateEmbedding, generateQueryEmbedding } from '@/lib/embeddings'

// ==================== TYPES ====================

export interface RewriteResult {
  /** Latest query rewritten to be self-contained (pronouns resolved). */
  rewrittenQuery: string
  /** HyDE — 3-5 sentence hypothetical answer to the rewritten query. */
  hypotheticalAnswer: string
  /** Up to 3 paraphrases of the rewritten query (empty on non-fatal failure). */
  expandedQueries: string[]
  /** Embedding of hypotheticalAnswer — THE HyDE search vector (passage space). */
  hydeEmbedding: number[]
  /** Embedding of rewrittenQuery (query input-type — for dense fallback). */
  queryEmbedding: number[]
  /** True when served from the in-memory LRU cache (no LLM/embedding calls). */
  cacheHit: boolean
  /** Wall-clock duration of THIS call (≈0 on cache hit). */
  durationMs: number
}

// ==================== CACHE (in-memory LRU + TTL) ====================

const CACHE_MAX_ENTRIES = 200
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

interface CacheEntry {
  result: RewriteResult
  expiresAt: number
}

/** Insertion-ordered Map = free LRU (first key = least recently used). */
const rewriteCache = new Map<string, CacheEntry>()

/**
 * Tiny djb2-style hash (embeddings.ts hashText is module-private and that
 * file is frozen for this task). Two passes (forward + backward) concatenated
 * → 64 bits of output, ample for a ≤200-entry cache.
 */
function hashCacheKey(text: string): string {
  let h1 = 5381
  let h2 = 52711
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = ((h1 << 5) + h1 + c) | 0
    h2 = ((h2 << 5) + h2 + c * (i + 1)) | 0
  }
  return (h1 >>> 0).toString(36) + '-' + (h2 >>> 0).toString(36)
}

function cacheGet(key: string): RewriteResult | null {
  const entry = rewriteCache.get(key)
  if (!entry) return null
  if (Date.now() >= entry.expiresAt) {
    rewriteCache.delete(key)
    return null
  }
  // LRU refresh: move to the back (most recently used) + slide the TTL.
  rewriteCache.delete(key)
  rewriteCache.set(key, { ...entry, expiresAt: Date.now() + CACHE_TTL_MS })
  return entry.result
}

function cacheSet(key: string, result: RewriteResult): void {
  // Evict oldest entries (Map iteration order = insertion order = LRU order).
  while (rewriteCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = rewriteCache.keys().next().value
    if (oldest === undefined) break
    rewriteCache.delete(oldest)
  }
  rewriteCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS })
}

/** Test/tuning hook — clears the in-memory rewrite cache. */
export function _clearQueryRewriteCache(): void {
  rewriteCache.clear()
}

// ==================== HELPERS ====================

/** Normalize an LLM "reply with ONLY X" answer: strip quotes, collapse whitespace. */
function cleanSingleLine(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse the expansion reply into up to 3 clean, deduped paraphrases. */
function parseParaphrases(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const q = cleanSingleLine(line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ''))
    if (!q || seen.has(q.toLowerCase())) continue
    seen.add(q.toLowerCase())
    out.push(q)
    if (out.length >= 3) break
  }
  return out
}

/** Only well-formed turns are usable as rewrite context. */
function validTurns(history: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  return history.filter(
    t => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string' && t.content.trim().length > 0
  )
}

// ==================== MAIN ====================

/**
 * Rewrite a user query for retrieval (Prop 3.9).
 *
 * @param query               The user's latest query, verbatim.
 * @param conversationHistory PRIOR turns (the query itself should NOT be included).
 *                            Only the last 2 user/assistant turns are used as context.
 * @returns RewriteResult, or null on any failure (caller falls back to plain query).
 */
export async function rewriteQuery(
  query: string,
  conversationHistory: Array<{ role: string; content: string }> = []
): Promise<RewriteResult | null> {
  const start = Date.now()
  try {
    if (!query || typeof query !== 'string' || query.trim().length === 0) return null

    // ---- 0. Cache lookup (key = query + last 2 turn contents) ----
    const turns = validTurns(conversationHistory).slice(-2)
    const historyKey = turns.map(t => `${t.role}:${t.content}`).join('||')
    const cacheKey = hashCacheKey(query + '|' + historyKey)
    const cached = cacheGet(cacheKey)
    if (cached) {
      return { ...cached, cacheHit: true, durationMs: Date.now() - start }
    }

    const wordCount = query.trim().split(/\s+/).filter(Boolean).length
    const historyBlock = turns
      .map(t => `${t.role}: ${t.content}`)
      .join('\n')

    // ---- 1. LLM call 1 (rewrite): resolve pronouns/context ----
    // Skip when the query is already self-contained: no history AND > 4 words.
    // (Saves 1 LLM call for the common single-turn case.)
    let rewrittenQuery = query.trim()
    if (turns.length > 0 || wordCount <= 4) {
      const rewritePrompt = [
        turns.length > 0
          ? `Conversation history (most recent last):\n${historyBlock}`
          : 'Conversation history: (none — the query is the whole conversation)',
        '',
        `Latest user query: "${query.trim()}"`,
        '',
        'Given the conversation history, rewrite the user\'s latest query to be self-contained and unambiguous (resolve pronouns like "it", "they", "that" and elliptical references using the context).',
        'Reply with ONLY the rewritten query — no quotes, no explanation.',
      ].join('\n')

      const rewriteRes = await callUtilityLLM(rewritePrompt, undefined, 'query-rewrite', {
        temperature: 0.3,
        maxTokens: 150,
      })
      const cleaned = cleanSingleLine(rewriteRes?.content || '')
      // Non-fatal: a failed rewrite falls back to the original query.
      if (cleaned.length > 0 && cleaned.length <= 1000) rewrittenQuery = cleaned
    }

    // ---- 2 + 3. HyDE + expansion (independent given rewrittenQuery → parallel) ----
    const hydePrompt = [
      `Write a 3-5 sentence hypothetical answer to the query below.`,
      'Write it as a knowledge-base document answering directly — concrete, factual, no meta-commentary, no "based on the query" phrasing.',
      '',
      `Query: "${rewrittenQuery}"`,
    ].join('\n')

    const expansionPrompt = [
      'Generate 3 alternative phrasings of the query below (different vocabulary, same intent — useful as extra retrieval queries).',
      'Reply with ONLY the 3 paraphrases, one per line — no numbering, no quotes, no explanation.',
      '',
      `Query: "${rewrittenQuery}"`,
    ].join('\n')

    // UTILITY CORE (user report 2026-09-05): rewrite/HyDE/expansion là tiền xử lý
    // retrieval — dùng lõi utility (zen space-bunny-free), không đụng lõi agent.
    const [hydeRes, expansionRes, queryEmb] = await Promise.all([
      callUtilityLLM(hydePrompt, undefined, 'query-hyde', { temperature: 0.5, maxTokens: 400 }),
      callUtilityLLM(expansionPrompt, undefined, 'query-expansion', { temperature: 0.7, maxTokens: 250 }),
      generateQueryEmbedding(rewrittenQuery),
    ])

    // HyDE failure is FATAL per spec — without the hypothetical answer there is
    // no HyDE vector, and the caller should just search with the plain query.
    const hypotheticalAnswer = (hydeRes?.content || '').trim()
    if (!hypotheticalAnswer) {
      console.warn('[QueryRewriter] HyDE generation failed — falling back to plain query')
      return null
    }

    // Expansion failure is NON-fatal (HyDE still works without paraphrases).
    const expandedQueries = parseParaphrases(expansionRes?.content || '')

    // ---- 4. Embed BOTH texts ----
    // hydeEmbedding: passage-space embedding of the hypothetical answer (HyDE core).
    const hydeEmb = await generateEmbedding(hypotheticalAnswer)
    // P0.1 — NO pseudo-hash fallback: empty vector = provider failure → bail.
    if (!hydeEmb?.vector || hydeEmb.vector.length === 0) {
      console.warn('[QueryRewriter] HyDE embedding unavailable — falling back to plain query (no pseudo-hash)')
      return null
    }
    // queryEmbedding: query-space embedding of the rewritten query. Non-fatal if
    // empty (hydeEmbedding is the primary search vector; this is the fallback).
    const queryEmbedding = queryEmb?.vector && queryEmb.vector.length > 0 ? queryEmb.vector : []

    const result: RewriteResult = {
      rewrittenQuery,
      hypotheticalAnswer,
      expandedQueries,
      hydeEmbedding: hydeEmb.vector,
      queryEmbedding,
      cacheHit: false,
      durationMs: Date.now() - start,
    }

    cacheSet(cacheKey, result)
    console.log(
      `[QueryRewriter] "${query.trim().slice(0, 60)}" → "${rewrittenQuery.slice(0, 60)}" | HyDE ${hypotheticalAnswer.length} chars | ${expandedQueries.length} expansions | ${result.durationMs}ms`
    )
    return result
  } catch (err) {
    // Contract: ANY failure → null (caller falls back to the plain query).
    console.warn('[QueryRewriter] Failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}
