/**
 * Full Restore — R2 → Qdrant + Neo4j
 *
 * Phase 3 SMOLAB Proposal 10.5
 *
 * POST /api/storage/restore-full?store={qdrant|neo4j|all}&date=YYYYMMDD
 *
 * Downloads a previously uploaded full backup from R2 and replays it into
 * Qdrant and/or Neo4j.
 *
 * DESTRUCTIVE for Qdrant — Qdrant's snapshot restore REPLACES the collection
 * contents. Caller must intend to overwrite existing chunks.
 *
 * NON-destructive for Neo4j — statements use MERGE / CREATE INDEX IF NOT EXISTS,
 * so re-running on a graph with existing data merges by id (no duplicates).
 * For a clean restore, caller should run `MATCH (n) DETACH DELETE n` first
 * (NOT done by this endpoint to avoid surprising the user).
 *
 * Query params:
 *   store = "qdrant" | "neo4j" | "all" (default "all")
 *   date  = YYYYMMDD — required (matches newest backup with that date prefix
 *          in backups/qdrant/{YYYYMMDD}*.tar OR backups/neo4j/{YYYYMMDD}*.cypher.gz).
 *          Pass "latest" to use the latest pointer (overwritten each backup run).
 *
 * Response shape:
 *   {
 *     date, store, startedAt, completedAt, status: 'completed',
 *     qdrant: { restoredPoints, sizeBytes, r2Key, snapshotName },
 *     neo4j:  { restoredNodes, restoredRels, sizeBytes, r2Key, statementsExecuted, statementsFailed }
 *   }
 *
 * Typical usage after a sandbox reset:
 *   # 1. Restore SQLite (existing endpoint):
 *   curl -X POST 'http://localhost:3000/api/storage/db-backup?action=restore'
 *   # 2. Restart so Prisma re-opens SQLite:
 *   pm2 restart theopusflashlite && sleep 15
 *   # 3. Restore Qdrant + Neo4j from latest R2 backup:
 *   curl -X POST 'http://localhost:3000/api/storage/restore-full?store=all&date=latest'
 *   # 4. (optional) Restart to refresh in-memory caches:
 *   pm2 restart theopusflashlite
 */
import { NextResponse } from 'next/server'
import { restoreQdrantFromR2 } from '@/lib/backup/qdrant-snapshot'
import { restoreNeo4jFromR2 } from '@/lib/backup/neo4j-dump'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Store = 'qdrant' | 'neo4j' | 'all'

interface RestoreResult {
  restoredPoints?: number
  restoredNodes?: number
  restoredRels?: number
  sizeBytes: number
  r2Key: string
  snapshotName?: string
  statementsExecuted?: number
  statementsFailed?: number
}

export async function POST(request: Request) {
  const url = new URL(request.url)
  const storeParam = (url.searchParams.get('store') || 'all') as Store
  const date = url.searchParams.get('date')

  if (!date) {
    return NextResponse.json(
      { error: 'date query param required (YYYYMMDD or "latest")' },
      { status: 400 }
    )
  }
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
        results.qdrant = (await restoreQdrantFromR2(date)) as RestoreResult
      } catch (err) {
        results.qdrant = {
          error: err instanceof Error ? err.message : String(err),
        }
        if (storeParam === 'all') {
          console.warn(
            '[Restore-Full] Qdrant restore failed — continuing to neo4j'
          )
        } else {
          throw err
        }
      }
    }

    if (storeParam === 'neo4j' || storeParam === 'all') {
      try {
        results.neo4j = (await restoreNeo4jFromR2(date)) as RestoreResult
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
    console.error('[Restore-Full] Error:', err)
    return NextResponse.json(
      {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Restore failed',
        ...results,
      },
      { status: 500 }
    )
  }
}
