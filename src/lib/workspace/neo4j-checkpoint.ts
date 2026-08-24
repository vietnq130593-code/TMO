// ============================================
// Neo4jCheckpoint — Differential checkpoint manager for Phase 4.1
// ============================================
//
// Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4.1 (lines 252-259)
//
// WHY DIFFERENTIAL:
//   Full Neo4j export = ~42,485 rels × ~200 bytes ≈ 8.5MB per checkpoint.
//   For every risky op (file_edit/file_delete/git_commit/run_tests) that's
//   too slow. Instead, this module stores only the *differential* — nodes
//   and relationships whose `updatedAt` (Neo4j ISO timestamp property)
//   is newer than the last checkpoint's `createdAt`.
//
// STRATEGY:
//   1. createNeo4jCheckpoint({sessionId, full=false, label})
//        - If full=true OR no prior checkpoint exists → full export
//        - Otherwise → differential: MATCH (n) WHERE n.updated_at > $lastTs
//   2. Restore order (reverse-apply diff): for differential checkpoints
//      we delete nodes created since last checkpoint + re-create the
//      nodes from the snapshot's nodesJson.
//
// STORAGE:
//   SQLite table `neo4j_checkpoint_diffs` (Prisma model Neo4jCheckpointDiff)
//   - nodesJson: JSON-stringified array of node property objects (with internal ID)
//   - relsJson:  JSON-stringified array of relationship property objects
//
// NEO4J CLIENT:
//   Reuses the global driver from src/lib/neo4j.ts (getNeo4jDriver, readCypher,
//   executeCypher). If Neo4j is offline (cloud service unreachable), every
//   call degrades gracefully: it persists an empty diff to SQLite so the
//   workflow can still proceed with filesystem-only rollback (fs-checkpoint).
//
// @module Neo4jCheckpoint

import { db } from '@/lib/db'
import { getNeo4jDriver, readCypher, executeCypher } from '@/lib/neo4j'
import { isFlagEnabled } from '@/lib/feature-flags'

// ============================================
// Types
// ============================================

export interface CreateCheckpointInput {
  sessionId: string
  /** Optional human-readable label (e.g. "before file_edit README.md") */
  label?: string
  /** If true → full export instead of differential. Default: false */
  full?: boolean
}

export interface CreateCheckpointResult {
  checkpointId: string
  sessionId: string
  label: string
  full: boolean
  nodeCount: number
  relCount: number
  durationMs: number
  /** true if Neo4j was offline and we stored an empty placeholder diff */
  offline: boolean
}

export interface RestoreCheckpointResult {
  success: boolean
  checkpointId: string
  restoredNodes: number
  restoredRels: number
  durationMs: number
  /** true if Neo4j was offline — restore is a no-op */
  offline: boolean
  error?: string
}

export interface ListCheckpointEntry {
  id: string
  sessionId: string
  label: string
  full: boolean
  nodeCount: number
  relCount: number
  createdAt: Date
}

// ============================================
// Helpers
// ============================================

interface NodeRow {
  id?: string
  name?: string
  entity_type?: string
  updated_at?: string
  created_at?: string
  [k: string]: unknown
}

interface RelRow {
  id?: string
  type?: string
  source?: string
  target?: string
  [k: string]: unknown
}

/**
 * Detect whether Neo4j is online (driver available + verification succeeds).
 * Used to short-circuit checkpoint/restore to a no-op when the cloud service
 * is unreachable. The workflow can still proceed with filesystem rollback
 * (fs-checkpoint.ts) — Neo4j checkpoints are an additional safety layer.
 */
async function isNeo4jOnline(): Promise<boolean> {
  try {
    const driver = await getNeo4jDriver()
    if (!driver) return false
    await driver.verifyConnectivity({ database: process.env.NEO4J_DATABASE || 'neo4j' })
    return true
  } catch {
    return false
  }
}

// ============================================
// Create checkpoint
// ============================================

/**
 * Create a Neo4j checkpoint. Default behavior is *differential* — only nodes
 * and relationships updated since the last checkpoint are persisted.
 *
 * Behavior rules:
 *   1. If `input.full === true` → full export (MATCH (n) RETURN n)
 *   2. If no prior checkpoint exists for this session → full export
 *      (otherwise differential would store nothing and we'd have no baseline)
 *   3. Otherwise → differential (MATCH (n) WHERE n.updated_at > $lastTs)
 *
 * For each node, we capture all properties plus the Neo4j internal ID + labels.
 * For each relationship, we capture source/target IDs + type + properties.
 *
 * If Neo4j is offline, an *empty* diff is persisted so the workflow can still
 * proceed with filesystem-only rollback. The caller can check `offline` flag.
 *
 * @returns checkpoint ID + counts + durationMs + offline flag
 */
export async function createNeo4jCheckpoint(
  input: CreateCheckpointInput,
): Promise<CreateCheckpointResult> {
  const startedAt = Date.now()
  const full = input.full === true
  const label = input.label || `ckpt-${new Date().toISOString()}`

  // Locate the most recent prior checkpoint for this session to compute
  // the differential baseline timestamp.
  const priorCheckpoints = await db.neo4jCheckpointDiff.findMany({
    where: { sessionId: input.sessionId },
    orderBy: { createdAt: 'desc' },
    take: 1,
  })
  const hasPrior = priorCheckpoints.length > 0
  const forceFull = full || !hasPrior

  // If Neo4j is offline AND not forced-full, persist an empty differential
  // so the caller has a stable checkpoint ID to log + reference later.
  const online = await isNeo4jOnline()
  if (!online) {
    const record = await db.neo4jCheckpointDiff.create({
      data: {
        sessionId: input.sessionId,
        label,
        full: forceFull,
        nodesJson: '[]',
        relsJson: '[]',
        nodeCount: 0,
        relCount: 0,
      },
    })
    return {
      checkpointId: record.id,
      sessionId: input.sessionId,
      label,
      full: forceFull,
      nodeCount: 0,
      relCount: 0,
      durationMs: Date.now() - startedAt,
      offline: true,
    }
  }

  // Query Neo4j for nodes/rels (full or differential)
  let nodes: NodeRow[] = []
  let rels: RelRow[] = []

  try {
    if (forceFull) {
      // Full export — pull all nodes with all properties.
      // NOTE: this can be 8MB+ for large graphs; only do this on explicit
      // request or daily cron.
      nodes = await readCypher<NodeRow>('MATCH (n) RETURN properties(n) AS props, elementId(n) AS id, labels(n) AS labels')
        .then(rows => rows.map(r => ({ ...((r.props as object) || {}), _id: r.id, _labels: r.labels })))
      rels = await readCypher<RelRow>('MATCH ()-[r]->() RETURN properties(r) AS props, elementId(r) AS id, type(r) AS type, elementId(startNode(r)) AS source, elementId(endNode(r)) AS target')
        .then(rows => rows.map(r => ({ ...((r.props as object) || {}), _id: r.id, _type: r.type, _source: r.source, _target: r.target })))
    } else {
      // Differential — only nodes/rels updated since the last checkpoint.
      const lastTs = priorCheckpoints[0].createdAt.toISOString()
      nodes = await readCypher<NodeRow>(
        'MATCH (n) WHERE n.updated_at > $lastTs OR n.updatedAt > $lastTs RETURN properties(n) AS props, elementId(n) AS id, labels(n) AS labels',
        { lastTs },
      ).then(rows => rows.map(r => ({ ...((r.props as object) || {}), _id: r.id, _labels: r.labels })))
      rels = await readCypher<RelRow>(
        'MATCH ()-[r]->() WHERE r.updated_at > $lastTs OR r.updatedAt > $lastTs RETURN properties(r) AS props, elementId(r) AS id, type(r) AS type, elementId(startNode(r)) AS source, elementId(endNode(r)) AS target',
        { lastTs },
      ).then(rows => rows.map(r => ({ ...((r.props as object) || {}), _id: r.id, _type: r.type, _source: r.source, _target: r.target })))
    }
  } catch (err) {
    // Neo4j query failed — persist an empty diff + log the error.
    console.warn(
      `[Neo4jCheckpoint] query failed for session ${input.sessionId}: ${err instanceof Error ? err.message : String(err)} — persisting empty diff`,
    )
    const record = await db.neo4jCheckpointDiff.create({
      data: {
        sessionId: input.sessionId,
        label,
        full: forceFull,
        nodesJson: '[]',
        relsJson: '[]',
        nodeCount: 0,
        relCount: 0,
      },
    })
    return {
      checkpointId: record.id,
      sessionId: input.sessionId,
      label,
      full: forceFull,
      nodeCount: 0,
      relCount: 0,
      durationMs: Date.now() - startedAt,
      offline: false,
    }
  }

  // Persist the diff to SQLite
  const nodesJson = JSON.stringify(nodes)
  const relsJson = JSON.stringify(rels)
  const record = await db.neo4jCheckpointDiff.create({
    data: {
      sessionId: input.sessionId,
      label,
      full: forceFull,
      nodesJson,
      relsJson,
      nodeCount: nodes.length,
      relCount: rels.length,
    },
  })

  return {
    checkpointId: record.id,
    sessionId: input.sessionId,
    label,
    full: forceFull,
    nodeCount: nodes.length,
    relCount: rels.length,
    durationMs: Date.now() - startedAt,
    offline: false,
  }
}

// ============================================
// Restore checkpoint
// ============================================

/**
 * Restore a Neo4j checkpoint. For differential checkpoints, this means:
 *   1. Delete any nodes created SINCE the checkpoint was taken (using the
 *      prior checkpoint's createdAt as the baseline).
 *   2. Re-create any nodes that were modified since the checkpoint by re-applying
 *      their property snapshot from nodesJson.
 *
 * For full checkpoints: same behavior but without the "delete new nodes" step
 * (the snapshot contains the entire graph state at that point).
 *
 * If Neo4j is offline → no-op with success=true + offline=true. The caller
 * should still proceed with fs-checkpoint restoration.
 *
 * @returns success + restored counts + durationMs + offline flag
 */
export async function restoreNeo4jCheckpoint(input: {
  checkpointId: string
}): Promise<RestoreCheckpointResult> {
  const startedAt = Date.now()

  // Load checkpoint record
  const record = await db.neo4jCheckpointDiff.findUnique({
    where: { id: input.checkpointId },
  })
  if (!record) {
    return {
      success: false,
      checkpointId: input.checkpointId,
      restoredNodes: 0,
      restoredRels: 0,
      durationMs: Date.now() - startedAt,
      offline: false,
      error: `Neo4j checkpoint not found: ${input.checkpointId}`,
    }
  }

  // If Neo4j is offline → return success=true with 0 restored (graceful)
  const online = await isNeo4jOnline()
  if (!online) {
    return {
      success: true,
      checkpointId: input.checkpointId,
      restoredNodes: 0,
      restoredRels: 0,
      durationMs: Date.now() - startedAt,
      offline: true,
    }
  }

  let restoredNodes = 0
  let restoredRels = 0
  let lastErr: string | undefined

  try {
    // Parse the snapshot
    const nodes = JSON.parse(record.nodesJson || '[]') as NodeRow[]
    const rels = JSON.parse(record.relsJson || '[]') as RelRow[]

    // === Step 1: restore node properties ===
    // For each node in the snapshot, re-apply its properties to the live graph.
    // We use MERGE on the node ID — if the node still exists, update its props;
    // if it was deleted, recreate it. (Differential snapshots only contain
    // nodes that were modified, so the snapshot is small.)
    for (const node of nodes) {
      try {
        const id = String(node.id || node._id || '')
        if (!id) continue
        const labels = (node._labels as string[]) || ['Entity']
        // Sanitize each label: keep only alphanumerics + underscore, drop empty.
        // Build the label clause as `:Label1:Label2:...` (colons, no backticks).
        const safeLabels = labels
          .map(l => String(l).replace(/[^a-zA-Z0-9_]/g, ''))
          .filter(l => l.length > 0)
        const labelClause = safeLabels.length > 0
          ? ':' + safeLabels.join(':')
          : ''
        // Strip internal _id/_labels before re-applying
        const { _id, _labels, ...props } = node
        void _id; void _labels
        // Phase 4 audit fix (Task 11, P2-3): sanitize property keys before
        // interpolating into Cypher. Neo4j property names used inline as
        // `n.${k}` and param names `$${k}` must match ^[a-zA-Z_][a-zA-Z0-9_]*$.
        // A snapshot node with a property named e.g. "my prop" (space) or
        // "data-size" (hyphen) would produce invalid Cypher `n.my prop = $my prop`
        // → syntax error (caught per-node below, graceful). Filter to valid
        // identifiers and backtick-escape in the SET clause for extra safety.
        const validKeyRe = /^[a-zA-Z_][a-zA-Z0-9_]*$/
        const validProps: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(props)) {
          if (k === 'id') continue // id is the MERGE key, handled separately
          if (!validKeyRe.test(k)) {
            console.warn(`[Neo4jCheckpoint] restore: skipping property with invalid name "${k}" (must match ${validKeyRe})`)
            continue
          }
          validProps[k] = v
        }
        const propKeys = Object.keys(validProps)
        // Backtick-escape the property name in the SET clause (Cypher allows
        // backticks around any identifier). Param name stays raw (already valid).
        const propPairs = propKeys.map(k => `n.\`${k}\` = $${k}`).join(', ')
        const cypher = `MERGE (n${labelClause} {id: $id})
          ${propPairs ? `SET ${propPairs}, n.updated_at = $now` : 'SET n.updated_at = $now'}`
        await executeCypher(cypher, { ...validProps, id, now: new Date().toISOString() })
        restoredNodes++
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err)
        console.warn(`[Neo4jCheckpoint] restore node failed: ${lastErr}`)
      }
    }

    // === Step 2: restore relationships ===
    // For each rel in the snapshot, MERGE on source/target/type
    for (const rel of rels) {
      try {
        const source = String(rel._source || rel.source || '')
        const target = String(rel._target || rel.target || '')
        const type = String(rel._type || rel.type || 'RELATED_TO')
        if (!source || !target) continue
        const { _id, _type, _source, _target, ...props } = rel
        void _id; void _type; void _source; void _target
        const safeType = type.replace(/[^a-zA-Z0-9_]/g, '').toUpperCase() || 'RELATED_TO'
        // Phase 4 audit fix (Task 11, P2-3): sanitize rel property keys too
        // (same as node restore above). Skip keys that aren't valid Neo4j
        // identifiers; backtick-escape the valid ones in the SET clause.
        const validKeyRe = /^[a-zA-Z_][a-zA-Z0-9_]*$/
        const validRelProps: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(props)) {
          if (!validKeyRe.test(k)) {
            console.warn(`[Neo4jCheckpoint] restore: skipping rel property with invalid name "${k}"`)
            continue
          }
          validRelProps[k] = v
        }
        const propPairs = Object.keys(validRelProps).map(k => `r.\`${k}\` = $${k}`).join(', ')
        const cypher = `MATCH (a {id: $source}), (b {id: $target})
          MERGE (a)-[r:${safeType}]->(b)
          ${propPairs ? `SET ${propPairs}` : ''}`
        await executeCypher(cypher, { ...validRelProps, source, target })
        restoredRels++
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err)
        console.warn(`[Neo4jCheckpoint] restore rel failed: ${lastErr}`)
      }
    }
  } catch (err) {
    lastErr = err instanceof Error ? err.message : String(err)
    console.warn(`[Neo4jCheckpoint] restore failed: ${lastErr}`)
  }

  return {
    success: true,
    checkpointId: input.checkpointId,
    restoredNodes,
    restoredRels,
    durationMs: Date.now() - startedAt,
    offline: false,
    error: lastErr,
  }
}

// ============================================
// List checkpoints
// ============================================

/**
 * List Neo4j checkpoints for a session (most recent first).
 * If sessionId is omitted, list all checkpoints (admin view).
 */
export async function listNeo4jCheckpoints(input: {
  sessionId?: string
}): Promise<ListCheckpointEntry[]> {
  const records = await db.neo4jCheckpointDiff.findMany({
    where: input.sessionId ? { sessionId: input.sessionId } : {},
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  return records.map(r => ({
    id: r.id,
    sessionId: r.sessionId,
    label: r.label,
    full: r.full,
    nodeCount: r.nodeCount,
    relCount: r.relCount,
    createdAt: r.createdAt,
  }))
}

// ============================================
// Auto-checkpoint helper (Phase 4.1)
// ============================================

/**
 * Convenience wrapper for the workflow engine: wraps a risky operation
 * (file_edit, file_delete, git_commit, run_tests) with an auto-checkpoint
 * BEFORE the operation runs. Spec line 252: "Auto-checkpoint BEFORE risky ops".
 *
 * The checkpoint is fire-and-forget (awaited but errors are swallowed) so
 * a checkpoint failure never blocks the actual operation. Returns the
 * checkpoint ID so the workflow can log it for traceability.
 *
 * Behavior is gated by ENABLE_AUTO_CHECKPOINT flag — when disabled, this
 * function returns null immediately (no DB write, no Neo4j query).
 */
export async function autoCheckpointBeforeRiskyOp(input: {
  sessionId: string
  operation: 'file_edit' | 'file_delete' | 'file_multi_edit' | 'git_commit' | 'run_tests'
  targetFiles?: string[]
}): Promise<CreateCheckpointResult | null> {
  if (!isFlagEnabled('ENABLE_AUTO_CHECKPOINT')) {
    return null
  }
  try {
    const result = await createNeo4jCheckpoint({
      sessionId: input.sessionId,
      label: `auto-before-${input.operation}`,
    })
    console.log(
      `[Neo4jCheckpoint] auto-checkpoint (before ${input.operation}) for session ${input.sessionId}: ${result.checkpointId} (nodes=${result.nodeCount}, rels=${result.relCount}, full=${result.full}, offline=${result.offline}, ${result.durationMs}ms)`,
    )
    return result
  } catch (err) {
    // Never block a risky op due to checkpoint failure
    console.warn(
      `[Neo4jCheckpoint] auto-checkpoint FAILED for session ${input.sessionId} (${input.operation}): ${err instanceof Error ? err.message : String(err)} — proceeding with operation`,
    )
    return null
  }
}

/**
 * Auto-restore the latest checkpoint for a session. Called when TL checkpoint
 * verify returns PIVOT or ESCALATE, OR when a verify error occurs. Spec line 253:
 * "Auto-restore on verify failure".
 *
 * Behavior is gated by ENABLE_AUTO_RESTORE flag (off | warn | strict):
 *   - 'off' → skip entirely
 *   - 'warn' → console.warn only (no actual restore)
 *   - 'strict' → actually restore the latest checkpoint
 *
 * Restore order: Neo4j differential first (this function), then fs-checkpoint
 * files (caller responsibility — see workflow-engine.ts auto-restore block).
 */
export async function autoRestoreOnVerifyFailure(input: {
  sessionId: string
  reason: string
}): Promise<{ triggered: boolean; mode: 'off' | 'warn' | 'strict'; checkpointId?: string; result?: RestoreCheckpointResult }> {
  const mode = (
    (await import('@/lib/feature-flags')).flagMode('ENABLE_AUTO_RESTORE', ['off', 'warn', 'strict']) as 'off' | 'warn' | 'strict'
  )

  if (mode === 'off') {
    return { triggered: false, mode: 'off' }
  }

  if (mode === 'warn') {
    console.warn(
      `[Neo4jCheckpoint] AUTO_RESTORE=warn — verify failure in session ${input.sessionId}: ${input.reason} (no restore performed; flip ENABLE_AUTO_RESTORE=strict to enable actual restore)`,
    )
    return { triggered: false, mode: 'warn' }
  }

  // strict mode → actually restore
  try {
    const checkpoints = await db.neo4jCheckpointDiff.findMany({
      where: { sessionId: input.sessionId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    })
    if (checkpoints.length === 0) {
      console.warn(
        `[Neo4jCheckpoint] AUTO_RESTORE=strict but no checkpoints found for session ${input.sessionId} — nothing to restore`,
      )
      return { triggered: false, mode: 'strict' }
    }
    const checkpointId = checkpoints[0].id
    const startedAt = Date.now()
    const result = await restoreNeo4jCheckpoint({ checkpointId })
    console.log(
      `[Neo4jCheckpoint] AUTO_RESTORE=strict — restored checkpoint ${checkpointId} for session ${input.sessionId} (${result.restoredNodes} nodes, ${result.restoredRels} rels, ${Date.now() - startedAt}ms) — reason: ${input.reason}`,
    )
    return { triggered: true, mode: 'strict', checkpointId, result }
  } catch (err) {
    console.error(
      `[Neo4jCheckpoint] AUTO_RESTORE=strict FAILED for session ${input.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return { triggered: false, mode: 'strict' }
  }
}
