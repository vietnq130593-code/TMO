/**
 * R31 — CORPUS OVERVIEW FETCHER (SERVER-ONLY — /api/brain dùng)
 * ============================================================================
 *
 * Đếm thật 6 nhóm corpus cho Brain-D "Tri Thức" (corpus-dims.ts là nguồn
 * định nghĩa). Nạp vào GET /api/brain entry `knowledge` (additive — UI
 * SECTION 1 hiển thị; D3 feature builder sau này tái dùng cùng nguồn).
 *
 * Ngân sách & an toàn:
 *  - Neo4j: 3 COUNT theo label — dùng COUNT STORE O(1) của AuraDB
 *    (MATCH (n:Label) RETURN count(n) — KHÔNG dùng getGraphStats vì bảng
 *    labels(n) UNWIND quét toàn đồ thị 96K+ node, quá đắt cho route poll).
 *  - Qdrant: 3 count exact theo collection (pattern getChunkCount qdrant.ts).
 *  - Cache bộ nhớ 60s (local memory caching doctrine — route /api/brain bị
 *    poll đều; 6 truy vấn xa xỉ nhất tốn 1 lần/phút, fail-open từng nguồn).
 *  - MỖI nguồn fail-open độc lập (null — tiền lệ safeCount /api/brain):
 *    Neo4j/Qdrant đứt thì response vẫn sống, UI hiển thị '—'.
 */

import { qdrant, COLLECTION_CHUNKS } from '@/lib/qdrant'
import { COLLECTION_COMMUNITIES } from '@/lib/kb-routing/communities'
import { COLLECTION_AGENT_MEMORY } from '@/lib/agent-memory'
import { readCypher } from '@/lib/neo4j'
import type { KnowledgeCorpusOverview } from './corpus-dims'

/** TTL cache bộ nhớ — route poll 30s nhưng số corpus đổi chậm (ingest/writeback). */
const CACHE_TTL_MS = 60_000

let cache: { at: number; data: KnowledgeCorpusOverview } | null = null

/** Đếm an toàn — lỗi → null (fail-open từng nguồn, tiền lệ safeCount). */
async function safeCount(fn: () => Promise<number | null>): Promise<number | null> {
  try {
    const v = await fn()
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** Neo4j COUNT theo query (count store O(1) cho MATCH (n:Label)). */
async function neo4jCount(query: string): Promise<number | null> {
  const rows = await readCypher<{ c: number }>(query)
  const c = rows[0]?.c
  return typeof c === 'number' && Number.isFinite(c) ? c : null
}

/** Qdrant count exact theo collection (pattern qdrant.ts getChunkCount). */
async function qdrantCount(collection: string): Promise<number | null> {
  const res = await qdrant.count(collection, { exact: true })
  return typeof res.count === 'number' && Number.isFinite(res.count) ? res.count : null
}

/**
 * Lấy tổng quan corpus 6 chiều (cache 60s; force=true bỏ qua cache).
 * KHÔNG bao giờ throw — mọi nguồn lỗi → null từng chiều (UI '—').
 */
export async function getKnowledgeCorpusOverview(force = false): Promise<KnowledgeCorpusOverview> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data

  const [graphNodes, lessons, episodes, chunks, communities, memories] = await Promise.all([
    safeCount(() => neo4jCount('MATCH (n) RETURN count(n) AS c')),
    safeCount(() => neo4jCount('MATCH (n:Lesson) RETURN count(n) AS c')),
    safeCount(() => neo4jCount('MATCH (n:Episode) RETURN count(n) AS c')),
    safeCount(() => qdrantCount(COLLECTION_CHUNKS)),
    safeCount(() => qdrantCount(COLLECTION_COMMUNITIES)),
    safeCount(() => qdrantCount(COLLECTION_AGENT_MEMORY)),
  ])

  const data: KnowledgeCorpusOverview = {
    graphNodes,
    lessons,
    episodes,
    chunks,
    communities,
    memories,
    fetchedAt: new Date().toISOString(),
  }
  cache = { at: Date.now(), data }
  return data
}
