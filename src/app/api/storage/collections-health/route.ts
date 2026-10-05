/**
 * COLLECTIONS HEALTH — Round-37 V1
 * ==================================
 * Rà soát lượt 3 (round-36): các collection PHỤ THUỘC (theopus_episodes,
 * theopus_communities, agent_memory, task_context) + kho episodic Neo4j +
 * SQLite mirror không có ô health riêng — chỉ theopus_chunks được dim-guard
 * + health chung "Qdrant connected". Một collection phụ mất điểm/desync
 * Neo4j↔Qdrant↔SQLite diễn ra im lặng (đúng lesson round-36: desync không
 * lộ ra health = bằng không với vận hành).
 *
 * GET /api/storage/collections-health trả từng collection 1 ô:
 *   qdrant[]   — name/exists/pointCount/dimExpected/dimActual/dimMismatch
 *                (6 collection: documents, chunks, episodes, communities,
 *                agent_memory, task_context)
 *   episodic   — Neo4j (episodes/lessons/errors) + SQLite mirror counts
 *   desync     — episodes qdrant↔neo4j, lessons neo4j↔sqlite-mirror
 *
 * Fail-open từng nhóm (Qdrant chết → qdrant[].exists=false nhưng vẫn 200).
 */

import { NextResponse } from 'next/server'
import { qdrant, EMBEDDING_DIMENSION, COLLECTION_DOCUMENTS, COLLECTION_CHUNKS } from '@/lib/qdrant'
import { COLLECTION_EPISODES } from '@/lib/episodic-memory/episode-store'
import { COLLECTION_COMMUNITIES } from '@/lib/kb-routing/communities'
import { COLLECTION_AGENT_MEMORY } from '@/lib/agent-memory'
import { COLLECTION_TASK_CONTEXT } from '@/lib/context-store'
import { readCypher } from '@/lib/neo4j'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** 6 collection Qdrant của hệ thống — tên + mô tả ngắn cho UI.
 * dimExpected=null → collection KHÔNG dùng vector semantic (documents là
 * payload-only 1-dim dummy theo thiết kế — qdrant.ts:151-155) → bỏ qua dim check.
 * ROUND-38 fix V1-3: tên collection lấy từ CONSTANT của từng module (env
 * QDRANT_COLLECTION_* override được) — trước đây hardcode khiến card báo
 * "Chưa tạo" false-positive khi operator đặt env override. */
const QDRANT_COLLECTIONS: Array<{ name: string; label: string; dimExpected?: number }> = [
  { name: COLLECTION_DOCUMENTS, label: 'Documents (metadata)', dimExpected: 1 },
  { name: COLLECTION_CHUNKS, label: 'Chunks (KB semantic — lõi chat/agent)' },
  { name: COLLECTION_EPISODES, label: 'Episodes (bộ nhớ kinh nghiệm agent)' },
  { name: COLLECTION_COMMUNITIES, label: 'Communities (Leiden — bức tranh lớn)' },
  { name: COLLECTION_AGENT_MEMORY, label: 'Agent Memory (ký ức hội thoại)' },
  { name: COLLECTION_TASK_CONTEXT, label: 'Task Context (working memory)' },
]

interface CollectionHealth {
  name: string
  label: string
  exists: boolean
  pointCount?: number
  dimExpected?: number
  dimActual?: number
  dimMismatch?: boolean
  error?: string
}

/** Lấy dim thật từ collection info (config.params.vectors.size — field path probe round-35) */
function extractDim(info: unknown): number | undefined {
  const cfg = (info as { config?: { params?: { vectors?: unknown } } })?.config?.params?.vectors
  if (cfg && !Array.isArray(cfg) && typeof cfg === 'object') {
    const size = (cfg as { size?: unknown }).size
    if (typeof size === 'number') return size
  }
  return undefined
}

async function checkQdrantCollections(): Promise<CollectionHealth[]> {
  const out: CollectionHealth[] = []
  let reachable = true
  try {
    await qdrant.getCollections()
  } catch {
    reachable = false
  }
  for (const col of QDRANT_COLLECTIONS) {
    if (!reachable) {
      out.push({ name: col.name, label: col.label, exists: false, error: 'Qdrant unreachable' })
      continue
    }
    try {
      const info = await qdrant.getCollection(col.name)
      const dimActual = extractDim(info)
      const dimExpected = col.dimExpected ?? EMBEDDING_DIMENSION
      out.push({
        name: col.name,
        label: col.label,
        exists: true,
        pointCount: info.points_count ?? 0,
        dimExpected,
        dimActual,
        dimMismatch: dimActual !== undefined && dimActual !== dimExpected,
      })
    } catch (colErr) {
      // ROUND-38 fix V1-6: phân biệt "chưa tạo" với "lỗi kết nối" — trước đây
      // mọi lỗi getCollection đều hiện "Chưa tạo" (che outage transient).
      const msg = colErr instanceof Error ? colErr.message : String(colErr)
      const transient = /timeout|econn|fetch|network|503|429/i.test(msg)
      out.push(
        transient
          ? { name: col.name, label: col.label, exists: false, error: `Lỗi kết nối: ${msg.slice(0, 120)}` }
          : { name: col.name, label: col.label, exists: false }, // 404 = chưa tạo thật
      )
    }
  }
  return out
}

export async function GET() {
  const startedAt = Date.now()
  try {
    const [qdrantCols, neo4jCounts, mirrorCounts] = await Promise.all([
      checkQdrantCollections().catch((): CollectionHealth[] =>
        QDRANT_COLLECTIONS.map(c => ({ name: c.name, label: c.label, exists: false, error: 'check failed' })),
      ),
      (async () => {
        try {
          const [ep, les, err] = await Promise.all([
            readCypher<{ n: unknown }>('MATCH (e:Episode) RETURN count(e) AS n'),
            readCypher<{ n: unknown }>('MATCH (l:Lesson) RETURN count(l) AS n'),
            readCypher<{ n: unknown }>('MATCH (e:ErrorOccurrence) RETURN count(e) AS n'),
          ])
          return {
            neo4jReachable: true,
            episodes: Number(ep[0]?.n ?? 0),
            lessons: Number(les[0]?.n ?? 0),
            errors: Number(err[0]?.n ?? 0),
          }
        } catch {
          return { neo4jReachable: false, episodes: 0, lessons: 0, errors: 0 }
        }
      })(),
      (async () => {
        try {
          const [epMirror, lesMirror] = await Promise.all([
            db.episodeRecord.count().catch(() => 0),
            db.lessonRecord.count().catch(() => 0),
          ])
          return { sqliteEpisodes: epMirror, sqliteLessons: lesMirror }
        } catch {
          return { sqliteEpisodes: 0, sqliteLessons: 0 }
        }
      })(),
    ])

    // Desync indicators (lesson round-36: cặp store phải có cách phát hiện lệch)
    // ROUND-38 fix V1-1: bổ sung cặp THỨ 3 episodes Neo4j ↔ SQLite mirror —
    // trước đây wipe chỉ SQLite (Qdrant+Neo4j nguyên vẹn) vẫn hiện "khớp".
    // ROUND-38 fix V1-2: desync = null khi BẤT KỲ bên nào không đo được
    // (outage) — trước đây Qdrant chết → episodesQdrant=0 → desync=96 amber
    // "boot-heal sẽ tự chạy" (heal không chữa được outage!), và total-fail
    // path trả desync=0 → XANH "khớp" giữa lúc sập toàn bộ. UI render "—".
    const episodesQdrant = qdrantCols.find(c => c.name === COLLECTION_EPISODES)?.pointCount
    const episodesQdrantReachable = qdrantCols.find(c => c.name === COLLECTION_EPISODES)?.exists === true
    const bothEpisodesReachable = episodesQdrantReachable && neo4jCounts.neo4jReachable
    const desync = {
      episodesQdrantNeo4j: bothEpisodesReachable ? Math.abs((episodesQdrant ?? 0) - neo4jCounts.episodes) : null,
      episodesNeo4jSqlite: neo4jCounts.neo4jReachable ? Math.abs(neo4jCounts.episodes - mirrorCounts.sqliteEpisodes) : null,
      lessonsNeo4jSqlite: neo4jCounts.neo4jReachable ? Math.abs(neo4jCounts.lessons - mirrorCounts.sqliteLessons) : null,
    }

    return NextResponse.json({
      qdrant: qdrantCols,
      episodic: { ...neo4jCounts, ...mirrorCounts },
      desync,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json(
      {
        qdrant: QDRANT_COLLECTIONS.map(c => ({ name: c.name, label: c.label, exists: false, error: 'check failed' })),
        episodic: { neo4jReachable: false, episodes: 0, lessons: 0, errors: 0, sqliteEpisodes: 0, sqliteLessons: 0 },
        desync: { episodesQdrantNeo4j: null, episodesNeo4jSqlite: null, lessonsNeo4jSqlite: null },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      },
      { status: 200 }, // fail-open — UI vẫn render được các ô đỏ
    )
  }
}
