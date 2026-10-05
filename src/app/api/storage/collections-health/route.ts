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
import { qdrant, EMBEDDING_DIMENSION } from '@/lib/qdrant'
import { readCypher } from '@/lib/neo4j'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** 6 collection Qdrant của hệ thống — tên + mô tả ngắn cho UI.
 * dimExpected=null → collection KHÔNG dùng vector semantic (documents là
 * payload-only 1-dim dummy theo thiết kế — qdrant.ts:151-155) → bỏ qua dim check. */
const QDRANT_COLLECTIONS: Array<{ name: string; label: string; dimExpected?: number }> = [
  { name: 'theopus_documents', label: 'Documents (metadata)', dimExpected: 1 },
  { name: 'theopus_chunks', label: 'Chunks (KB semantic — lõi chat/agent)' },
  { name: 'theopus_episodes', label: 'Episodes (bộ nhớ kinh nghiệm agent)' },
  { name: 'theopus_communities', label: 'Communities (Leiden — bức tranh lớn)' },
  { name: 'agent_memory', label: 'Agent Memory (ký ức hội thoại)' },
  { name: 'task_context', label: 'Task Context (working memory)' },
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
    } catch {
      // Collection chưa tồn tại → exists=false (không phải lỗi hệ thống)
      out.push({ name: col.name, label: col.label, exists: false })
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
    const episodesQdrant = qdrantCols.find(c => c.name === 'theopus_episodes')?.pointCount ?? 0
    const desync = {
      episodesQdrantNeo4j: Math.abs(episodesQdrant - neo4jCounts.episodes),
      lessonsNeo4jSqlite: Math.abs(neo4jCounts.lessons - mirrorCounts.sqliteLessons),
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
        desync: { episodesQdrantNeo4j: 0, lessonsNeo4jSqlite: 0 },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      },
      { status: 200 }, // fail-open — UI vẫn render được các ô đỏ
    )
  }
}
