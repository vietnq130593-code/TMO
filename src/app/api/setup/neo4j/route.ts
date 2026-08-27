/**
 * Neo4j Setup API — Schema initialization and cleanup
 *
 * Architecture:
 *   SQLite (buffer) → Qdrant (vector+document) + Neo4j (graph)
 *
 * - POST: Initialize Neo4j constraints and indexes
 * - GET: Check Neo4j connection status
 * - DELETE ?action=clean: Clean up all Neo4j data and re-sync
 */

import { NextRequest, NextResponse } from 'next/server'
import { checkNeo4jHealth, initializeNeo4jSchema, getNeo4jDriver, safeSession } from '@/lib/neo4j'
import { listDocuments, updateDocumentStatus } from '@/lib/qdrant'
import type { DocumentPayload } from '@/lib/qdrant'

export const dynamic = 'force-dynamic'

// Increase max duration for AuraDB schema init (can take 10-30 seconds)
export const maxDuration = 300

/**
 * POST /api/setup/neo4j
 * Initialize Neo4j constraints and indexes
 */
export async function POST() {
  try {
    const health = await checkNeo4jHealth()

    if (!health.connected) {
      return NextResponse.json(
        { success: false, error: 'Cannot connect to Neo4j. Check your credentials and ensure the database is running.' },
        { status: 500 }
      )
    }

    const schema = await initializeNeo4jSchema()

    return NextResponse.json({
      success: true,
      message: `Neo4j schema initialized: ${schema.constraints} constraints, ${schema.indexes} indexes`,
      health,
      schema,
    })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    )
  }
}

/**
 * GET /api/setup/neo4j
 * Check Neo4j connection status
 */
export async function GET() {
  const health = await checkNeo4jHealth()
  return NextResponse.json({ health })
}

/**
 * DELETE /api/setup/neo4j?action=clean
 * Clean up all Neo4j data and re-sync from Qdrant + SQLite buffer.
 * Fixes the cross-product relationship bug by deleting inflated relationships
 * and re-syncing with the correct ID-based approach.
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')

    if (action !== 'clean') {
      return NextResponse.json({ error: 'Use ?action=clean to clean up Neo4j data' }, { status: 400 })
    }

    const driver = await getNeo4jDriver()
    if (!driver) {
      return NextResponse.json({ error: 'Neo4j not connected' }, { status: 500 })
    }

    // Step 1: Count existing data before cleanup
    let countSession: import('neo4j-driver').Session | null = null
    try { countSession = await safeSession() } catch { return NextResponse.json({ error: 'Neo4j not connected' }, { status: 500 }) }
    let beforeNodes = 0; let beforeRels = 0
    try {
      const nodeResult = await countSession.executeRead(tx => tx.run('MATCH (n) RETURN count(n) AS cnt'))
      beforeNodes = Number(nodeResult.records[0]?.get('cnt') ?? 0)
      const relResult = await countSession.executeRead(tx => tx.run('MATCH ()-[r]->() RETURN count(r) AS cnt'))
      beforeRels = Number(relResult.records[0]?.get('cnt') ?? 0)
    } finally { await countSession?.close().catch(() => {}) }

    console.log(`[Neo4j Clean] Before: ${beforeNodes} nodes, ${beforeRels} relationships`)

    // SAFETY BACKUP (DATA-LOSS FIX 2026-08-31): before wiping, dump all nodes + rels
    // to a local JSON file in db/ so the wipe is reversible. Best-effort — the clean
    // still proceeds if the backup fails, but the response reports it.
    let backup: { file?: string; nodes: number; rels: number; error?: string } = { nodes: 0, rels: 0 }
    try {
      const { readCypher } = await import('@/lib/neo4j')
      const nodes = await readCypher<{ props: Record<string, unknown>; labels: string[]; eid: string }>(
        'MATCH (n) RETURN properties(n) AS props, labels(n) AS labels, elementId(n) AS eid'
      )
      const rels = await readCypher<{ props: Record<string, unknown>; type: string; source: string; target: string; rid: string }>(
        'MATCH ()-[r]->() RETURN properties(r) AS props, type(r) AS type, elementId(startNode(r)) AS source, elementId(endNode(r)) AS target, elementId(r) AS rid'
      )
      const fs = await import('fs/promises')
      const path = await import('path')
      const backupDir = path.join(process.cwd(), 'db')
      await fs.mkdir(backupDir, { recursive: true })
      const fileName = `neo4j-pre-clean-backup-${Date.now()}.json`
      const filePath = path.join(backupDir, fileName)
      await fs.writeFile(filePath, JSON.stringify({
        createdAt: new Date().toISOString(),
        reason: 'setup/neo4j?action=clean',
        note: 'Restore by re-creating nodes/rels from this dump (labels in _labels, type in _type).',
        nodes: nodes.map(n => ({ ...n.props, _labels: n.labels, _eid: n.eid })),
        rels: rels.map(r => ({ ...r.props, _type: r.type, _source: r.source, _target: r.target, _rid: r.rid })),
      }), 'utf-8')
      backup = { file: fileName, nodes: nodes.length, rels: rels.length }
      console.log(`[Neo4j Clean] Safety backup written: ${fileName} (${nodes.length} nodes, ${rels.length} rels)`)
    } catch (err) {
      backup = { nodes: 0, rels: 0, error: err instanceof Error ? err.message : String(err) }
      console.warn('[Neo4j Clean] Safety backup FAILED (continuing with clean):', backup.error)
    }

    // Step 2: Delete ALL nodes and relationships
    let cleanSession: import('neo4j-driver').Session | null = null
    try { cleanSession = await safeSession() } catch { return NextResponse.json({ error: 'Neo4j not connected' }, { status: 500 }) }
    try {
      await cleanSession.executeWrite(tx => tx.run('MATCH (n) DETACH DELETE n'))
      console.log('[Neo4j Clean] All nodes and relationships deleted')
    } finally { await cleanSession?.close().catch(() => {}) }

    // Step 3: Reset Neo4j step for all documents that had Neo4j data
    // Read documents from Qdrant and reset processing_steps
    const targetStatuses = ['indexed', 'partial', 'extracting', 'extracted']
    let resetCount = 0

    for (const status of targetStatuses) {
      const { documents: docs } = await listDocuments({ status, limit: 1000 })
      for (const doc of docs) {
        const steps = doc.payload.processing_steps as Array<{ step: string; status: string; timestamp: string }> | null
        if (steps && Array.isArray(steps)) {
          // Check if there's a neo4j step to reset
          const hasNeo4jStep = steps.some(s => s.step === 'neo4j')
          if (hasNeo4jStep) {
            // Reset neo4j step to pending
            const updatedSteps = steps.map(s =>
              s.step === 'neo4j'
                ? { ...s, status: 'pending', timestamp: new Date().toISOString() }
                : s
            )
            await updateDocumentStatus(doc.id, {
              processing_steps: updatedSteps as DocumentPayload['processing_steps'],
            })
            resetCount++
          }
        }
      }
    }

    // Step 4: Verify cleanup
    let verifySession: import('neo4j-driver').Session | null = null
    try { verifySession = await safeSession() } catch { /* already cleaned */ }
    let afterNodes = 0; let afterRels = 0
    try {
      const nodeResult = await verifySession!.executeRead(tx => tx.run('MATCH (n) RETURN count(n) AS cnt'))
      afterNodes = Number(nodeResult.records[0]?.get('cnt') ?? 0)
      const relResult = await verifySession!.executeRead(tx => tx.run('MATCH ()-[r]->() RETURN count(r) AS cnt'))
      afterRels = Number(relResult.records[0]?.get('cnt') ?? 0)
    } finally { await verifySession?.close().catch(() => {}) }

    console.log(`[Neo4j Clean] After: ${afterNodes} nodes, ${afterRels} relationships`)

    return NextResponse.json({
      success: true,
      message: `Cleaned Neo4j: ${beforeNodes}→${afterNodes} nodes, ${beforeRels}→${afterRels} relationships. Reset ${resetCount} documents for re-sync.` + (backup.file ? ` Safety backup: ${backup.file} (${backup.nodes} nodes, ${backup.rels} rels).` : ''),
      before: { nodes: beforeNodes, relationships: beforeRels },
      after: { nodes: afterNodes, relationships: afterRels },
      documentsReset: resetCount,
      backup,
    })
  } catch (err) {
    console.error('[Neo4j Clean] Error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Neo4j cleanup failed' },
      { status: 500 }
    )
  }
}
