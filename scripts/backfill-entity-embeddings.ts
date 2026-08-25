/**
 * Phase 2 SMOLAB Proposal 2.5 — One-time backfill of Neo4j entity embeddings.
 *
 * Iterates all entities across the 8 labels (Concept, Technology, Framework,
 * Vulnerability, Principle, Domain, Document, Person), generates an embedding
 * for each (name + description), and SETs n.embedding on the node.
 *
 * Required for ENABLE_SEMANTIC_ENTITY_SEARCH to return hits — without the
 * embedding property, the per-label vector indexes have nothing to index.
 *
 * Usage:
 *   cd /home/z/tmo-app && set -a && source .env && set +a && bunx tsx scripts/backfill-entity-embeddings.ts
 *   # Options: --dry-run | --label=Concept | --limit=500 | --batch-size=50
 *
 * Est. for ~16k entities: 16000 × (~0.4s embed + 0.5s pace) ≈ 2 hours.
 * Interruptible — rerun skips entities that already have n.embedding set.
 */

import { db } from '../src/lib/db'
import { generateEmbedding } from '../src/lib/embeddings'

const LABELS = ['Concept', 'Technology', 'Framework', 'Vulnerability', 'Principle', 'Domain', 'Document', 'Person']

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const labelArg = args.find(a => a.startsWith('--label='))
  const onlyLabel = labelArg ? labelArg.split('=')[1] : null
  const limitArg = args.find(a => a.startsWith('--limit='))
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 100000
  const batchArg = args.find(a => a.startsWith('--batch-size='))
  const batchSize = batchArg ? parseInt(batchArg.split('=')[1], 10) : 50

  console.log(`[Backfill] dryRun=${dryRun}, label=${onlyLabel || 'ALL'}, limit=${limit}, batch=${batchSize}`)

  const labels = onlyLabel ? [onlyLabel] : LABELS
  const { readCypher, executeCypher } = await import('../src/lib/neo4j')

  let totalProcessed = 0
  let totalUpdated = 0
  let totalSkipped = 0
  let totalFailed = 0

  for (const label of labels) {
    // Count candidates (no embedding yet)
    const countRes = await readCypher<{ c: number }>(
      `MATCH (n:${label}) WHERE n.embedding IS NULL RETURN count(n) AS c`
    )
    const candidates = Number(countRes[0]?.c ?? 0)
    console.log(`[Backfill] ${label}: ${candidates} entities without embedding`)

    let processed = 0
    while (processed < candidates && processed < limit) {
      // Fetch a batch WITHOUT embedding
      const rows = await readCypher<{ id: string; name: string; description?: string }>(
        `MATCH (n:${label}) WHERE n.embedding IS NULL
         RETURN n.id AS id, n.name AS name, n.description AS description
         LIMIT toInteger($batch)`,
        { batch: batchSize }
      )
      if (!rows || rows.length === 0) break

      for (const row of rows) {
        processed++
        totalProcessed++
        if (totalProcessed > limit) break

        const text = `${row.name}: ${row.description || ''}`.slice(0, 2000)
        if (!row.name) {
          totalSkipped++
          continue
        }

        if (dryRun) {
          console.log(`[Backfill] DRY RUN ${label}/${row.id}: would embed "${String(row.name).slice(0, 50)}"`)
          totalUpdated++
          continue
        }

        try {
          const { vector } = await generateEmbedding(text)
          if (vector.length === 0) {
            console.warn(`[Backfill] Embedding failed for ${row.id} — NVIDIA unreachable, stopping this label`)
            totalFailed++
            continue
          }

          await executeCypher(
            `MATCH (n:${label} {id: $id}) SET n.embedding = $vec`,
            { id: row.id, vec: vector }
          )
          totalUpdated++
          await new Promise(r => setTimeout(r, 400))
        } catch (err) {
          console.warn(`[Backfill] Failed ${row.id}:`, err instanceof Error ? err.message : String(err))
          totalFailed++
        }
      }
      console.log(`[Backfill] ${label}: ${processed}/${candidates} processed`)
    }
  }

  console.log('')
  console.log('================ Backfill Summary ================')
  console.log(`  Processed: ${totalProcessed}`)
  console.log(`  Updated:   ${totalUpdated}`)
  console.log(`  Skipped:   ${totalSkipped}`)
  console.log(`  Failed:    ${totalFailed}`)
  console.log('=================================================')

  await db.$disconnect().catch(() => {})
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Backfill] FAILED:', err)
    process.exit(1)
  })
