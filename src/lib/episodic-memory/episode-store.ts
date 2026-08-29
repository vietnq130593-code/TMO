/**
 * EPISODE STORE — Qdrant semantic index cho Episodic Memory (A6 · A.5)
 *
 * Qdrant giữ vai trò SEMANTIC INDEX (tìm episode GIỐNG), Neo4j giữ CẤU
 * TRÚC & QUAN HỆ (pattern lỗi, lesson, chuỗi thời gian) — episodic-neo4j.ts.
 *
 * Collection `theopus_episodes` (2048-dim Cosine — cùng dimension
 * theopus_chunks/agent_memory):
 *   - Upsert: embed summary episode → point {id = episodeId, payload metadata}
 *   - Search: embed query/task → top-K episodes (cosine ≥ 0.8 → [:SIMILAR_TO])
 *
 * Fail-open tuyệt đối: embedding provider chết → vector rỗng → skip
 * (episode vẫn ghi Neo4j, chỉ thiếu semantic search). KHÔNG throw lên
 * caller — agent runtime không bao giờ được hỏng vì memory phụ trợ.
 */

import { qdrant } from '@/lib/qdrant'
import {
  generateEmbedding,
  generateQueryEmbedding,
  getEmbeddingDimension,
} from '@/lib/embeddings'
import { EPISODIC_THRESHOLDS } from './types'

const COLLECTION_EPISODES = 'theopus_episodes'

/**
 * Deterministic UUID từ string (SHA-1 → format UUID v5-style) — Qdrant point
 * id phải là UUID; re-record cùng episodeId → cùng point id → upsert đè.
 */
function deterministicUuid(seed: string): string {
  // 4 hex đầu từ hash — đủ độ phân tán cho sandbox; KHÔNG dùng cho crypto
  let hash = ''
  for (let i = 0; i < 5; i++) {
    // FNV-1a 32-bit lặp — đơn giản, không dependency
    let h = 0x811c9dc5
    const s = `${seed}#${i}`
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    hash += h.toString(16).padStart(8, '0')
  }
  const hex = hash.slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Đã ensure collection trong process này chưa */
const g = globalThis as unknown as { __tmoEpisodesCollectionReady?: boolean }

export interface EpisodePointPayload {
  episode_id: string
  title: string
  goal: string
  outcome: string
  agent: string
  session_id?: string
  importance: number
  stop_reason?: string
  /** Text đã embed (debug + hiển thị) */
  summary_text: string
  created_at: string
  [key: string]: unknown
}

export interface EpisodeSearchHit {
  episodeId: string
  score: number
  payload: EpisodePointPayload
}

/**
 * Ensure collection `theopus_episodes` tồn tại — idempotent (check
 * existence trước create), copy pattern ensureAgentMemoryCollection.
 */
export async function ensureEpisodeCollection(): Promise<boolean> {
  if (g.__tmoEpisodesCollectionReady) return true
  try {
    const collections = await qdrant.getCollections()
    const names = new Set(collections.collections.map(c => c.name))
    if (!names.has(COLLECTION_EPISODES)) {
      await qdrant.createCollection(COLLECTION_EPISODES, {
        vectors: {
          size: getEmbeddingDimension(),
          distance: 'Cosine',
        },
        hnsw_config: { ef_construct: 128, m: 16, full_scan_threshold: 10000 },
        optimizers_config: { indexing_threshold: 10000 },
      })
      try {
        await qdrant.createPayloadIndex(COLLECTION_EPISODES, {
          field_name: 'agent', field_schema: 'keyword',
        })
        await qdrant.createPayloadIndex(COLLECTION_EPISODES, {
          field_name: 'outcome', field_schema: 'keyword',
        })
      } catch { /* index đã có hoặc không cần thiết */ }
      console.log(`[Episodic] Created Qdrant collection ${COLLECTION_EPISODES} (${getEmbeddingDimension()}-dim)`)
    }
    g.__tmoEpisodesCollectionReady = true
    return true
  } catch (err) {
    console.error('[Episodic] ensureEpisodeCollection failed:', err instanceof Error ? err.message : String(err))
    return false
  }
}

/**
 * Upsert 1 episode point: embed summary → point (UUID — Qdrant chỉ nhận
 * UUID/integer, KHÔNG nhận "ep_..." string) → trả embeddingId (point UUID)
 * nếu thành công, null nếu skip (provider chết hoặc Qdrant down) — caller
 * ghi Neo4j vẫn tiếp tục. Payload luôn mang episode_id để map ngược.
 */
export async function upsertEpisodeEmbedding(params: {
  episodeId: string
  /** Text embed: "goal + context + outcome + lỗi chính" (pipeline A.5 bước 1-2) */
  summaryText: string
  payload: Omit<EpisodePointPayload, 'summary_text' | 'episode_id'>
}): Promise<string | null> {
  const { episodeId, summaryText, payload } = params
  try {
    await ensureEpisodeCollection()
    const { vector } = await generateEmbedding(summaryText.slice(0, 4000))
    if (!vector || vector.length === 0) {
      // FIX pattern (agent-memory RESET-2026-08-30): mọi provider chết →
      // vector rỗng → KHÔNG ghi point vô nghĩa, vẫn trả null để caller đi tiếp
      console.warn('[Episodic] embed provider chết — skip Qdrant point cho episode', episodeId)
      return null
    }
    // FIX (E2E 2026-08-29): Qdrant point id phải là UUID — "ep_..." bị 400
    // Bad Request. Deterministic UUID v5-style từ episodeId (crypto hash) để
    // re-record cùng episode không nhân bản point (upsert đè cùng id).
    const pointId = deterministicUuid(episodeId)
    await qdrant.upsert(COLLECTION_EPISODES, {
      wait: true,
      points: [{
        id: pointId,
        vector,
        payload: {
          episode_id: episodeId,
          summary_text: summaryText.slice(0, 2000),
          ...payload,
        } as Record<string, unknown>,
      }],
    })
    return pointId
  } catch (err) {
    console.error('[Episodic] upsertEpisodeEmbedding failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Search episodes tương tự theo semantics (pipeline A.5 bước 3).
 * Trả hits cosine ≥ EPISODIC_THRESHOLDS.episodeSimilarity (0.8),
 * sắp theo score DESC — caller tạo [:SIMILAR_TO {score}].
 */
export async function searchSimilarEpisodes(params: {
  queryText: string
  topK?: number
  minScore?: number
  /** 'passage' = so summary↔summary (recorder — score đối xứng); 'query' = so user-task↔episodes (PRE-ACT — cross-type, score thấp hơn, caller hạ minScore) */
  mode?: 'passage' | 'query'
}): Promise<EpisodeSearchHit[]> {
  const { queryText, topK = 3, minScore = EPISODIC_THRESHOLDS.episodeSimilarity, mode = 'query' } = params
  try {
    await ensureEpisodeCollection()
    const { vector } = mode === 'passage'
      ? await generateEmbedding(queryText.slice(0, 4000))
      : await generateQueryEmbedding(queryText.slice(0, 4000))
    if (!vector || vector.length === 0) return []
    const result = await qdrant.query(COLLECTION_EPISODES, {
      query: vector,
      limit: topK * 2, // lấy dư để lọc score
      with_payload: true,
    })
    const hits: EpisodeSearchHit[] = []
    for (const p of result.points) {
      const score = p.score ?? 0
      if (score < minScore) continue
      const payload = (p.payload ?? {}) as unknown as EpisodePointPayload
      // Point id là UUID (deterministic từ episodeId) — episodeId THẬT nằm
      // trong payload.episode_id (fix E2E 2026-08-29)
      const episodeId = String(payload.episode_id ?? p.id)
      hits.push({ episodeId, score, payload })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK)
  } catch (err) {
    console.error('[Episodic] searchSimilarEpisodes failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/** Point count cho dashboard */
export async function getEpisodePointCount(): Promise<number> {
  try {
    const info = await qdrant.getCollection(COLLECTION_EPISODES)
    return info.points_count ?? 0
  } catch {
    return 0
  }
}
