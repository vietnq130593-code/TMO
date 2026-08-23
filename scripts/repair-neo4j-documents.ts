/**
 * Repair Neo4j graph — rebuild Document nodes + CONTAINS relationships
 *
 * PROBLEM (fixed in the ingestion pipeline on the same date):
 *   The ingestion pipeline (`writeEntitiesToNeo4j`) never created Document
 *   nodes. Its Step 6 (`MATCH (d:Document {id: $documentId}) ... MERGE
 *   (d)-[:CONTAINS]->(e)`) silently matched nothing, so entities never got
 *   CONTAINS links — and Step 7's orphan cleanup
 *   (`... NOT (n)<-[:CONTAINS]-(:Document) ... LIMIT 1000 DETACH DELETE`)
 *   then deleted up to 1000 unprotected entity nodes on every fresh document
 *   processing. This script repairs the existing graph data.
 *
 * WHAT THIS SCRIPT DOES (all operations are idempotent MERGE — safe to run
 * while extraction is in progress; no deletes):
 *   1. Collect distinct documentIds from relationship properties (r.documentId)
 *   2. For each document: MERGE a real Document node (title from the SQLite
 *      Document table when available, otherwise the docId)
 *   3. Create CONTAINS relationships Document → every entity referenced by
 *      that document's relationships (source_entity_id / target_entity_id)
 *   4. Report how many entity nodes are now protected from orphan cleanup
 *
 * Usage:
 *   cd /home/z/tmo-app && bun scripts/repair-neo4j-documents.ts
 */

import neo4j from 'neo4j-driver'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const uri = process.env.NEO4J_URI!
  const user = process.env.NEO4J_USER!
  const password = process.env.NEO4J_PASSWORD!
  const database = process.env.NEO4J_DATABASE || 'neo4j'

  if (!uri || !user || !password) {
    console.error('Missing NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD env vars')
    process.exit(1)
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), { connectionTimeout: 30000 })
  const session = driver.session({ database })

  try {
    // ---- Before: count unprotected entity nodes ----
    const before = await session.run(
      `MATCH (n) WHERE n.entity_type IS NOT NULL AND n.entity_type <> 'Document'
       AND NOT (n)<-[:CONTAINS]-(:Document)
       RETURN count(n) AS c`
    )
    const unprotectedBefore = before.records[0].get('c').toNumber()
    console.log(`[Repair] Unprotected entity nodes BEFORE: ${unprotectedBefore}`)

    // ---- Step 1: distinct documentIds from rels ----
    const docIdsResult = await session.run(
      `MATCH ()-[r]->() WHERE r.documentId IS NOT NULL
       RETURN DISTINCT r.documentId AS docId`
    )
    const docIds: string[] = docIdsResult.records.map(r => r.get('docId')).filter(Boolean)
    console.log(`[Repair] Found ${docIds.length} distinct documentIds in relationships`)

    // ---- Step 2+3: per document, MERGE Document node + CONTAINS rels ----
    let totalContains = 0
    for (const docId of docIds) {
      try {
        // Title lookup from SQLite Document table (best-effort)
        let title = docId
        try {
          const doc = await prisma.document.findUnique({ where: { id: docId }, select: { title: true } })
          if (doc?.title) title = doc.title
        } catch { /* SQLite lookup failed — use docId as title */ }

        const now = new Date().toISOString()

        // MERGE the real Document node (idempotent)
        await session.run(
          `MERGE (d:Document {id: $docId})
           SET d.title = $title,
               d.name = $title,
               d.entity_name = $title,
               d.entity_type = 'Document',
               d.domain = COALESCE(d.domain, 'mixed'),
               d.status = COALESCE(d.status, 'indexed'),
               d.documentId = $docId,
               d.document_id = $docId,
               d.created_at = COALESCE(d.created_at, $now),
               d.updated_at = $now`,
          { docId, title, now }
        )

        // Create CONTAINS rels to every entity referenced by this document's rels
        // (both endpoints). MERGE → idempotent, safe on re-runs.
        const containsResult = await session.run(
          `MATCH ()-[r]->() WHERE r.documentId = $docId
           WITH COLLECT(DISTINCT r.source_entity_id) + COLLECT(DISTINCT r.target_entity_id) AS ids
           UNWIND ids AS eid
           WITH DISTINCT eid WHERE eid IS NOT NULL
           MATCH (d:Document {id: $docId}), (e {id: eid})
           MERGE (d)-[c:CONTAINS]->(e)
           SET c.documentId = $docId, c.document_id = $docId
           RETURN count(c) AS created`,
          { docId }
        )
        const created = containsResult.records[0]?.get('created')?.toNumber?.() || 0
        totalContains += created
        console.log(`[Repair]   ${docId.slice(0, 8)}... (${title.slice(0, 50)}): ${created} CONTAINS links`)
      } catch (docErr) {
        console.error(`[Repair]   ${docId.slice(0, 8)}... FAILED: ${docErr instanceof Error ? docErr.message : String(docErr)}`)
      }
    }

    console.log(`[Repair] Total CONTAINS links ensured: ${totalContains}`)

    // ---- After: count unprotected entity nodes ----
    const after = await session.run(
      `MATCH (n) WHERE n.entity_type IS NOT NULL AND n.entity_type <> 'Document'
       AND NOT (n)<-[:CONTAINS]-(:Document)
       RETURN count(n) AS c`
    )
    const unprotectedAfter = after.records[0].get('c').toNumber()

    const totalNodes = await session.run(`MATCH (n) WHERE n.entity_type IS NOT NULL AND n.entity_type <> 'Document' RETURN count(n) AS c`)
    const totalEntityNodes = totalNodes.records[0].get('c').toNumber()

    console.log(`\n[Repair] Entity nodes: ${totalEntityNodes}`)
    console.log(`[Repair] Unprotected BEFORE: ${unprotectedBefore}`)
    console.log(`[Repair] Unprotected AFTER:  ${unprotectedAfter}`)
    console.log(`[Repair] Protected: ${totalEntityNodes - unprotectedAfter}/${totalEntityNodes} (${(((totalEntityNodes - unprotectedAfter) / totalEntityNodes) * 100).toFixed(1)}%)`)

    if (unprotectedAfter > 0) {
      console.log(`\n[Repair] NOTE: ${unprotectedAfter} entity nodes are still unprotected (they appear in no relationship of any known document). They are at risk from the old orphan-cleanup bug — the pipeline fix prevents future occurrences. To also protect these, re-process the source documents.`)
    }
  } finally {
    await session.close()
    await driver.close()
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error('[Repair] Fatal:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
