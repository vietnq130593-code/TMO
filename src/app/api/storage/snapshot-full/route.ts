/**
 * Full Backup Snapshot — Qdrant + Neo4j → Cloudflare R2
 *
 * Phase 3 SMOLAB Proposal 10.5
 *
 * POST /api/storage/snapshot-full?store={qdrant|neo4j|all}
 *   Triggers a full backup of the requested store(s):
 *     - qdrant  : Qdrant chunks collection snapshot → binary tar → R2
 *     - neo4j   : Neo4j graph apoc.export.cypher.all → gzipped cypher → R2
 *     - all     : both (default)
 *
 * GET /api/storage/snapshot-full
 *   Lists the 10 most recent backups in each R2 prefix.
 *
 * WHY THIS EXISTS
 * ---------------
 * The existing /api/storage/db-backup endpoint snapshots the SQLite file
 * (processing state — Document/JobQueue/LocalEntity metadata). But the actual
 * knowledge base — vector embeddings in Qdrant + entity graph in Neo4j — is
 * NOT in SQLite. When the sandbox resets, SQLite restores but Qdrant and
 * Neo4j are EMPTY → GraphRAG queries return nothing.
 *
 * This endpoint complements db-backup by snapshotting Qdrant + Neo4j to R2.
 *
 * RUNTIME NOTES
 * -------------
 * - Qdrant snapshot is synchronous in v1.19 (~1s for 1045 chunks, ~20MB tar).
 * - Neo4j apoc.export.cypher.all takes ~5-10s for 15K nodes / 44K rels,
 *   producing a 27MB cypher script that gzips to ~3-5MB.
 * - Combined "store=all" runs both sequentially — total ~30s typical, but
 *   allow generous curl --max-time (300s) for safety.
 *
 * R2 STORAGE LAYOUT (S1 — multi-collection, blueprint BACKUP-GATE P1)
 * -------------------------------------------------------------
 *   backups/qdrant/<collection>/{YYYYMMDD-HHMMSS}.tar — versioned (history)
 *   backups/qdrant/<collection>/latest.tar             — overwritten each run
 *   backups/qdrant/{YYYYMMDD-HHMMSS}.tar               — LEGACY dual-write
 *   backups/qdrant/latest.tar                            (chỉ theopus_chunks)
 *   backups/neo4j/{YYYYMMDD-HHMMSS}.cypher.gz — versioned (history)
 *   backups/neo4j/latest.cypher.gz            — overwritten each run
 *
 * Restore: POST /api/storage/restore-full?store={qdrant|neo4j|all}&date=YYYYMMDD[&force=1]
 */
import { NextResponse } from 'next/server'
import {
  backupQdrantToR2,
  listQdrantBackups,
  getChunksPointCount,
  getCollectionPointCount,
  getBackupCollections,
  type QdrantBackupEntry,
} from '@/lib/backup/qdrant-snapshot'
import {
  backupNeo4jToR2,
  listNeo4jBackups,
  checkApocAvailability,
} from '@/lib/backup/neo4j-dump'

export const dynamic = 'force-dynamic'
// Long-running backups — Next.js may try to abort at 10s by default in dev;
// give plenty of headroom (max value).
export const maxDuration = 300

type Store = 'qdrant' | 'neo4j' | 'all'

interface BackupResult {
  r2Key: string
  sizeBytes: number
  collectionPoints?: number
  snapshotName?: string
  /** S1.1 — kết quả per-collection (5 collection mặc định). */
  collections?: Array<{
    collection: string
    status: 'ok' | 'skipped' | 'error'
    r2Key?: string
    sizeBytes?: number
    collectionPoints?: number
    snapshotName?: string
    reason?: string
  }>
  rawCypherBytes?: number
  nodeCount?: number
  relCount?: number
  propertiesCount?: number
  exportMs?: number
}

/**
 * POST: trigger a full backup of the requested store(s).
 *
 * Query params:
 *   store = "qdrant" | "neo4j" | "all" (default "all")
 */
export async function POST(request: Request) {
  const url = new URL(request.url)
  const storeParam = (url.searchParams.get('store') || 'all') as Store
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '') // YYYYMMDD

  if (!['qdrant', 'neo4j', 'all'].includes(storeParam)) {
    return NextResponse.json(
      {
        error: `Invalid store "${storeParam}". Use 'qdrant', 'neo4j', or 'all'.`,
      },
      { status: 400 }
    )
  }

  const results: Record<string, unknown> = {
    date,
    store: storeParam,
    startedAt: new Date().toISOString(),
  }

  try {
    if (storeParam === 'qdrant' || storeParam === 'all') {
      try {
        results.qdrant = (await backupQdrantToR2()) as BackupResult
      } catch (err) {
        results.qdrant = {
          error: err instanceof Error ? err.message : String(err),
        }
        // If both stores requested and qdrant fails, continue to neo4j
        if (storeParam === 'all') {
          console.warn(
            '[Snapshot-Full] Qdrant backup failed — continuing to neo4j'
          )
        } else {
          throw err
        }
      }
    }

    if (storeParam === 'neo4j' || storeParam === 'all') {
      try {
        // Pre-check APOC availability — gives a clear error instead of
        // attempting a 27MB export that would fail
        const apoc = await checkApocAvailability()
        if (!apoc.available) {
          throw new Error(
            `apoc.export.cypher.all not available on this Neo4j instance. ` +
              `apoc.version() returned: ${apoc.version ?? 'null'}. ` +
              `Error: ${apoc.error ?? 'no error detail'}`
          )
        }
        results.neo4jApocVersion = apoc.version
        results.neo4j = (await backupNeo4jToR2()) as BackupResult
      } catch (err) {
        results.neo4j = {
          error: err instanceof Error ? err.message : String(err),
        }
        if (storeParam === 'neo4j') throw err
      }
    }

    results.status = 'completed'
    results.completedAt = new Date().toISOString()
    return NextResponse.json(results)
  } catch (err) {
    console.error('[Snapshot-Full] Error:', err)
    return NextResponse.json(
      {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Snapshot failed',
        ...results,
      },
      { status: 500 }
    )
  }
}

/**
 * GET: list recent backups in R2 (10 mới nhất per store cho compat UI +
 * grouping byCollection + point count per-collection — S1.2).
 */
export async function GET() {
  const startedAt = new Date().toISOString()

  // Lấy rộng (200) để group byCollection đủ ý nghĩa — flat list cho UI cũ vẫn
  // cắt 10 như trước (compat trường `qdrantBackups`).
  const [allQdrantBackups, neo4jBackups, currentChunksCount] = await Promise.all([
    listQdrantBackups(200).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
      items: [] as QdrantBackupEntry[],
    })),
    listNeo4jBackups(10).catch((err) => ({
      error: err instanceof Error ? err.message : String(err),
      items: [],
    })),
    getChunksPointCount().catch(() => 0),
  ])

  // S1.2 — byCollection: group theo field `collection` (mỗi collection tối đa
  // 10 key mới nhất). Root keys (legacy, trước S1) gom dưới nhãn theopus_chunks.
  const byCollection: Record<string, QdrantBackupEntry[]> = {}
  if (Array.isArray(allQdrantBackups)) {
    for (const entry of allQdrantBackups) {
      const list = (byCollection[entry.collection] ??= [])
      if (list.length < 10) list.push(entry)
    }
  }

  // S1.2 — point count từng collection trong scope backup (map per-collection;
  // trường cũ `currentQdrantPoints` vẫn = chunks cho compat UI/docs cũ).
  const currentQdrantPointsByCollection: Record<string, number> = {}
  for (const collection of getBackupCollections()) {
    currentQdrantPointsByCollection[collection] = await getCollectionPointCount(collection).catch(
      () => 0
    )
  }

  return NextResponse.json({
    status: 'ok',
    timestamp: startedAt,
    currentQdrantPoints: currentChunksCount,
    currentQdrantPointsByCollection,
    qdrantBackups: Array.isArray(allQdrantBackups)
      ? allQdrantBackups.slice(0, 10)
      : [],
    byCollection,
    qdrantBackupsError: !Array.isArray(allQdrantBackups)
      ? (allQdrantBackups as { error?: string }).error
      : undefined,
    neo4jBackups: Array.isArray(neo4jBackups)
      ? neo4jBackups
      : [],
    neo4jBackupsError: !Array.isArray(neo4jBackups) ? neo4jBackups.error : undefined,
    r2Storage: {
      qdrantPrefix: 'backups/qdrant/',
      qdrantPerCollectionPrefix: 'backups/qdrant/<collection>/',
      neo4jPrefix: 'backups/neo4j/',
      latest: {
        qdrant: 'backups/qdrant/latest.tar',
        qdrantPerCollection: 'backups/qdrant/<collection>/latest.tar',
        neo4j: 'backups/neo4j/latest.cypher.gz',
      },
    },
    endpoints: {
      'POST ?store=qdrant': 'Snapshot Qdrant (5 collection mặc định) → R2 binary tar',
      'POST ?store=neo4j': 'Snapshot Neo4j graph → R2 gzipped cypher',
      'POST ?store=all': 'Both (default)',
      'POST /api/storage/restore-full?store={...}&date=YYYYMMDD[&force=1]':
        'Restore from R2 (date prefix match; force=1 bỏ policy restoreIfEmpty)',
    },
  })
}
