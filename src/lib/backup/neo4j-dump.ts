/**
 * Neo4j Graph Dump Backup/Restore → Cloudflare R2
 *
 * Phase 3 SMOLAB Proposal 10.5
 *
 * Why this exists
 * ---------------
 * The Neo4j AuraDB knowledge graph holds 15,951 entity nodes + 44,061
 * relationships extracted from documents — this is the GraphRAG traversal
 * layer for agent queries. When the AuraDB project is reset (or sandbox
 * disaster recovery is needed), the graph is wiped. Re-extracting from
 * documents costs LLM tokens + processing time.
 *
 * This module performs a FULL graph backup using `apoc.export.cypher.all`
 * (which we verified WORKS on AuraDB Free tier — see worklog Task
 * 8-SMOLAB-PHASE3-PROP10.5-FULL-BACKUP Step 10.5.3). The procedure returns
 * a single cypher script (~27MB plain text for the current graph) containing
 * schema + node + relationship + cleanup statements.
 *
 * Workflow
 * --------
 * BACKUP:
 *   1. CALL apoc.export.cypher.all(null, {stream:true, format:'plain', batchSize:100000})
 *      YIELD cypherStatements, nodes, relationships, properties, time
 *   2. gzip the cypher text → typically 27MB → ~3-5MB compressed
 *   3. Upload to R2 at backups/neo4j/{YYYYMMDD-HHMMSS}.cypher.gz
 *      AND backups/neo4j/latest.cypher.gz (overwritten each run)
 *
 * RESTORE:
 *   1. Download .cypher.gz from R2
 *   2. gunzip → cypher text
 *   3. Split by `;` at end-of-statement (string-literal-aware parser to
 *      avoid splitting inside quoted strings/backticks)
 *   4. Execute each statement via session.run(); log failures but continue
 *      (idempotent — schema statements use IF NOT EXISTS, MERGE statements
 *      deduplicate by ID)
 *   5. MATCH (n) RETURN count(n) → verify restored node count
 *
 * APOC availability
 * ----------------
 * Verified on the project's AuraDB Free tier (Neo4j 5.x, APOC 2026.07.1):
 *   apoc.version() → "2026.07.1"
 *   apoc.export.cypher.all(null, {stream:true, format:'plain', batchSize:100000})
 *     → returns cypherStatements (27MB), nodes=15951, relationships=44061
 *
 * If APOC is NOT available on a future AuraDB instance (e.g., a degraded
 * tier), this module will throw a clear error and the manual fallback path
 * is to iterate over ENTITY_LABELS + RELATIONSHIP_TYPES and run MATCH/RETURN
 * queries per label — documented in the worklog, NOT implemented here (would
 * add complexity + ~200 lines for a scenario that Aura Free tier handles
 * natively via APOC).
 *
 * R2 storage layout
 * -----------------
 *   backups/neo4j/{YYYYMMDD-HHMMSS}.cypher.gz  — versioned snapshot
 *   backups/neo4j/latest.cypher.gz             — overwritten each run
 *
 * @module backup/neo4j-dump
 */

import { gzipSync, gunzipSync } from 'node:zlib'
import { uploadToR2, downloadFromR2, listR2Objects } from '@/lib/r2-storage'
import { readCypher, safeSession } from '@/lib/neo4j'

// ==================== CONFIG ====================

const R2_PREFIX = 'backups/neo4j/'
const R2_LATEST_KEY = 'backups/neo4j/latest.cypher.gz'

// ==================== TYPES ====================

export interface Neo4jBackupResult {
  r2Key: string
  sizeBytes: number  // gzipped size
  rawCypherBytes: number  // uncompressed cypher text size
  nodeCount: number
  relCount: number
  propertiesCount: number
  exportMs: number  // time spent inside APOC
}

export interface Neo4jRestoreResult {
  restoredNodes: number
  restoredRels: number
  sizeBytes: number
  r2Key: string
  statementsExecuted: number
  statementsFailed: number
}

// ==================== HELPERS ====================

/** Format a YYYYMMDD-HHMMSS timestamp (local). */
function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

// ==================== BACKUP ====================

/**
 * Trigger `apoc.export.cypher.all` on Neo4j, gzip the resulting cypher script,
 * and upload to R2.
 *
 * @returns {r2Key, sizeBytes, rawCypherBytes, nodeCount, relCount, ...}
 */
export async function backupNeo4jToR2(): Promise<Neo4jBackupResult> {
  // 1. Call APOC export — verified working on AuraDB Free tier (Neo4j 5.x,
  //    APOC 2026.07.1). batchSize:100000 ensures all 44061 relationships are
  //    included (apoc defaults to batchSize=20000 which would truncate).
  const query = `CALL apoc.export.cypher.all(null, {stream:true, format:'plain', batchSize: 100000})
    YIELD cypherStatements, nodes, relationships, properties, time
    RETURN cypherStatements, nodes, relationships, properties, time`
  console.log('[Neo4jBackup] CALL apoc.export.cypher.all (stream:true)')

  const rows = await readCypher<{
    cypherStatements: string
    nodes: { toNumber?: () => number } | number
    relationships: { toNumber?: () => number } | number
    properties: { toNumber?: () => number } | number
    time: { toNumber?: () => number } | number
  }>(query)

  if (rows.length === 0) {
    throw new Error('apoc.export.cypher.all returned no rows — check APOC availability')
  }
  const row = rows[0]
  const cypherText: string = row.cypherStatements
  if (!cypherText || cypherText.length === 0) {
    throw new Error('apoc.export.cypher.all returned empty cypherStatements')
  }

  const toNum = (v: { toNumber?: () => number } | number): number =>
    typeof v === 'number' ? v : v?.toNumber?.() ?? 0

  const nodeCount = toNum(row.nodes)
  const relCount = toNum(row.relationships)
  const propertiesCount = toNum(row.properties)
  const exportMs = toNum(row.time)

  console.log(
    `[Neo4jBackup] APOC export complete: ${nodeCount} nodes, ${relCount} rels, ` +
      `${propertiesCount} properties, exportMs=${exportMs}, cypherText=${cypherText.length} bytes`
  )

  // 2. gzip the cypher text — typically compresses 27MB → ~3-5MB
  const rawCypherBytes = Buffer.byteLength(cypherText, 'utf8')
  const gzipped = gzipSync(Buffer.from(cypherText, 'utf8'))
  const sizeBytes = gzipped.length
  console.log(
    `[Neo4jBackup] Gzipped: ${rawCypherBytes} → ${sizeBytes} bytes (${(sizeBytes / 1024 / 1024).toFixed(2)} MB, ratio=${(sizeBytes / rawCypherBytes * 100).toFixed(1)}%)`
  )

  // 3. Upload to R2 — versioned + latest pointer
  const ts = timestamp()
  const versionedKey = `${R2_PREFIX}${ts}.cypher.gz`
  const versionedResult = await uploadToR2(
    versionedKey,
    gzipped,
    'application/gzip'
  )
  if (!versionedResult.success) {
    throw new Error(`R2 upload failed (versioned): ${versionedResult.error}`)
  }

  const latestResult = await uploadToR2(
    R2_LATEST_KEY,
    gzipped,
    'application/gzip'
  )
  if (!latestResult.success) {
    console.warn(
      `[Neo4jBackup] Failed to update latest pointer (non-fatal): ${latestResult.error}`
    )
  }

  console.log(
    `[Neo4jBackup] Uploaded to R2: ${versionedKey} (${sizeBytes} bytes gzipped) + latest pointer`
  )

  return {
    r2Key: versionedKey,
    sizeBytes,
    rawCypherBytes,
    nodeCount,
    relCount,
    propertiesCount,
    exportMs,
  }
}

// ==================== STATEMENT PARSER ====================

/**
 * Split a cypher script into individual statements.
 *
 * Cypher statements are separated by `;` characters, BUT semicolons can also
 * appear inside string literals (single quotes, double quotes, backticks).
 * This parser walks the input character-by-character tracking string-literal
 * state to avoid splitting inside strings.
 *
 * Empty statements (after split + trim) are dropped.
 *
 * NOTE on multi-line UNWIND blocks: APOC emits each statement as a single
 * multi-line cypher query terminated by `;`. Splitting by top-level `;`
 * correctly produces one statement per UNWIND/MERGE block.
 */
export function splitCypherStatements(script: string): string[] {
  const statements: string[] = []
  let buf = ''
  let i = 0
  const n = script.length

  while (i < n) {
    const ch = script[i]

    // Line comment: // to end of line
    if (ch === '/' && script[i + 1] === '/') {
      // append comment verbatim until \n (we keep the comment in the statement
      // so the parser doesn't see semicolons inside comments)
      let j = i
      while (j < n && script[j] !== '\n') j++
      buf += script.slice(i, j)
      i = j
      continue
    }

    // Block comment: /* ... */
    if (ch === '/' && script[i + 1] === '*') {
      let j = i + 2
      while (j < n - 1 && !(script[j] === '*' && script[j + 1] === '/')) j++
      j += 2
      buf += script.slice(i, j)
      i = j
      continue
    }

    // String literals — single quote (with escape '')
    if (ch === "'") {
      let j = i + 1
      while (j < n) {
        if (script[j] === '\\') {
          j += 2
          continue
        }
        if (script[j] === "'") {
          if (script[j + 1] === "'") {
            // escaped single quote ('') — keep going
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      buf += script.slice(i, j)
      i = j
      continue
    }

    // String literals — double quote
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (script[j] === '\\') {
          j += 2
          continue
        }
        if (script[j] === '"') {
          j++
          break
        }
        j++
      }
      buf += script.slice(i, j)
      i = j
      continue
    }

    // Backtick identifier — used for property keys, labels, etc.
    if (ch === '`') {
      let j = i + 1
      while (j < n && script[j] !== '`') {
        // Backtick escape: doubled backticks inside backtick string
        if (script[j] === '`' && script[j + 1] === '`') {
          j += 2
          continue
        }
        j++
      }
      j++ // include closing backtick
      buf += script.slice(i, j)
      i = j
      continue
    }

    // Top-level semicolon → end of statement
    if (ch === ';') {
      const stmt = buf.trim()
      if (stmt.length > 0) statements.push(stmt)
      buf = ''
      i++
      continue
    }

    buf += ch
    i++
  }

  // Last statement (if no trailing semicolon)
  const tail = buf.trim()
  if (tail.length > 0) statements.push(tail)

  return statements
}

// ==================== RESTORE ====================

/**
 * Find the R2 key for a backup matching the given date prefix.
 *
 * @param date - YYYYMMDD; finds newest `backups/neo4j/{date}*.cypher.gz`
 */
async function findBackupKey(date: string): Promise<string | null> {
  const list = await listR2Objects(R2_PREFIX, 500)
  if (!list.success) {
    throw new Error(`R2 list failed: ${list.error}`)
  }

  const matches = list.objects
    .filter((o) => {
      const name = o.key.split('/').pop() || ''
      return (
        (name.startsWith(`${date}-`) || name === 'latest.cypher.gz') &&
        name.endsWith('.cypher.gz')
      )
    })
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())

  // Prefer dated matches over latest pointer
  const dated = matches.filter((o) => {
    const name = o.key.split('/').pop() || ''
    return name.startsWith(`${date}-`)
  })
  if (dated.length > 0) return dated[0].key

  if (date === 'latest') {
    const latest = matches.find((o) => o.key === R2_LATEST_KEY)
    if (latest) return latest.key
  }
  return null
}

/**
 * Download a Neo4j cypher dump from R2, gunzip, and replay it statement-by-statement.
 *
 * Restore is NON-destructive — statements use MERGE / CREATE INDEX IF NOT EXISTS,
 * so re-running on a graph with existing data will merge by id (no duplicates).
 * To do a "clean" restore, the caller should run `MATCH (n) DETACH DELETE n`
 * before invoking restore.
 *
 * @param date - YYYYMMDD; matches newest `backups/neo4j/{date}*.cypher.gz`.
 *               Use "latest" to pull the latest pointer.
 */
export async function restoreNeo4jFromR2(
  date: string
): Promise<Neo4jRestoreResult> {
  // 1. Resolve R2 key
  const r2Key = await findBackupKey(date)
  if (!r2Key) {
    throw new Error(
      `No Neo4j backup found matching date prefix "${date}" in R2 prefix "${R2_PREFIX}"`
    )
  }
  console.log(`[Neo4jRestore] Using R2 key: ${r2Key}`)

  // 2. Download + gunzip
  const dl = await downloadFromR2(r2Key)
  if (!dl.success || !dl.buffer) {
    throw new Error(`R2 download failed: ${dl.error}`)
  }
  const gzipped = dl.buffer
  const sizeBytes = dl.size || gzipped.length

  let cypherText: string
  try {
    cypherText = gunzipSync(gzipped).toString('utf8')
  } catch (err) {
    throw new Error(
      `Gunzip failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  console.log(
    `[Neo4jRestore] Gunzipped: ${sizeBytes} → ${cypherText.length} bytes cypher text`
  )

  // 3. Split into statements
  const statements = splitCypherStatements(cypherText)
  console.log(
    `[Neo4jRestore] Parsed ${statements.length} statements from cypher script`
  )

  // 4. Execute statements sequentially, skipping failures
  //    APOC's plain format wraps batches in :begin/:commit markers for the
  //    `browser` format only; `plain` format emits raw UNWIND/MERGE/CREATE
  //    statements which neo4j-driver can execute one at a time.
  let statementsExecuted = 0
  let statementsFailed = 0
  const failures: string[] = []

  // Batch statements by transaction type — schema statements (CREATE INDEX)
  // need to run in separate transactions from data statements (MERGE).
  // We simply run each statement in its own transaction via session.run().
  const session = await safeSession().catch((err) => {
    throw new Error(
      `Neo4j session unavailable for restore: ${err instanceof Error ? err.message : String(err)}`
    )
  })

  try {
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]
      // Skip directive-only statements (:begin, :commit, etc. — these are
      // emitted by `browser` format; `plain` doesn't emit them, but be safe)
      if (/^:(begin|commit|rollback|sleep|schema)$/i.test(stmt)) {
        continue
      }
      try {
        await session.run(stmt)
        statementsExecuted++
      } catch (err) {
        statementsFailed++
        const msg = err instanceof Error ? err.message : String(err)
        // Log first 3 failures in detail; count remaining
        if (failures.length < 3) {
          failures.push(`#${i + 1}: ${msg.slice(0, 200)}`)
        }
        // Continue with next statement — most failures are idempotent
        // (already-existing index/constraint) and don't break the restore.
      }
      // Progress log every 500 statements
      if ((i + 1) % 500 === 0) {
        console.log(
          `[Neo4jRestore] Progress: ${i + 1}/${statements.length} (executed=${statementsExecuted}, failed=${statementsFailed})`
        )
      }
    }
  } finally {
    await session.close().catch(() => {})
  }

  if (failures.length > 0) {
    console.warn(
      `[Neo4jRestore] First ${failures.length} failures:`,
      failures.join(' | ')
    )
  }
  console.log(
    `[Neo4jRestore] Statement replay complete: executed=${statementsExecuted}, failed=${statementsFailed}`
  )

  // 5. Verify restored node count
  const verifyRows = await readCypher<{ count: number }>(
    'MATCH (n) RETURN count(n) AS count'
  )
  const restoredNodes = verifyRows[0]?.count ?? 0

  // Also verify relationship count
  const relRows = await readCypher<{ count: number }>(
    'MATCH ()-[r]->() RETURN count(r) AS count'
  )
  const restoredRels = relRows[0]?.count ?? 0

  console.log(
    `[Neo4jRestore] Post-restore verify: ${restoredNodes} nodes, ${restoredRels} rels`
  )

  return {
    restoredNodes,
    restoredRels,
    sizeBytes,
    r2Key,
    statementsExecuted,
    statementsFailed,
  }
}

// ==================== LIST (for GET endpoint) ====================

/**
 * List recent Neo4j backups stored in R2.
 */
export async function listNeo4jBackups(limit: number = 10): Promise<
  Array<{
    key: string
    name: string
    date: string | null
    sizeBytes: number
    lastModified: string
  }>
> {
  const list = await listR2Objects(R2_PREFIX, 500)
  if (!list.success) return []

  return list.objects
    .filter((o) => o.key.endsWith('.cypher.gz'))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())
    .slice(0, limit)
    .map((o) => {
      const name = o.key.split('/').pop() || o.key
      const m = name.match(/(\d{8})-\d{6}\.cypher\.gz$/)
      return {
        key: o.key,
        name,
        date: m ? m[1] : null,
        sizeBytes: o.size,
        lastModified: o.lastModified.toISOString(),
      }
    })
}

// ==================== TEST HELPER (not exported via API) ====================

/**
 * Test if `apoc.export.cypher.all` is available on the connected Neo4j.
 * Used by the snapshot-full endpoint to give a clear error message before
 * attempting a 27MB export that would fail.
 */
export async function checkApocAvailability(): Promise<{
  available: boolean
  version: string | null
  error?: string
}> {
  try {
    const rows = await readCypher<{ v: string | null }>(
      'RETURN apoc.version() AS v'
    )
    const v = rows[0]?.v ?? null
    return {
      available: v !== null,
      version: typeof v === 'string' ? v : null,
    }
  } catch (err) {
    return {
      available: false,
      version: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

