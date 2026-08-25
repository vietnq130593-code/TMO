/**
 * Phase 3 SMOLAB Proposal 4.1 — Re-embed all chunks.
 *
 * Use cases:
 *   1. After NVIDIA silently updates nemotron-embed-1b-v2 — old vectors
 *      invalidated (cosine sim drops from 1.0 to ~0.6).
 *   2. After changing NVIDIA_EMBED_DIMENSIONS — dimension mismatch breaks
 *      cosine sim entirely.
 *   3. After restoring Qdrant from an R2 backup created with an older model.
 *   4. After a sandbox reset (restored snapshot contains garbage pseudo-hash
 *      vectors from before the Phase 6 P0.1 fix — cosine 0.000 vs any query).
 *
 * Scrolls through every chunk in COLLECTION_CHUNKS, re-embeds the text content
 * with the CURRENT active EmbeddingModelVersion, and upserts the point back
 * with the new vector + the current version tag in the payload.
 *
 * Idempotent: chunks already at the current version are skipped (no API call).
 *
 * Usage:
 *   cd /home/z/tmo-app && bunx tsx scripts/reembed-all.ts [--dry-run] [--batch-size=100] [--max=10000] [--pace-ms=50] [--only-stale]
 *
 * Options:
 *   --dry-run           Log what would be re-embedded but don't call NVIDIA or write Qdrant.
 *   --batch-size=N      Points per scroll page (default 100).
 *   --max=N             Hard cap on total points processed (default 10000).
 *   --pace-ms=N         Sleep N ms between upserts (default 50 — NVIDIA 40 RPM/key × 4 keys).
 *   --only-stale        Only re-embed points whose embedding_model_version ≠ current.
 *                       (Default: also re-embed points with NO version field — pre-Prop 4.1 chunks.)
 *
 * NOTE: bunx tsx does NOT auto-load .env (Next.js does at runtime). When the
 * script seems to see 0 NVIDIA keys, run it with env loaded:
 *   set -a && source .env && set +a && bunx tsx scripts/reembed-all.ts
 * However, this script primarily uses the embeddings module which loads env
 * itself, and the DB path comes from prisma client default — usually works
 * without sourcing. If the L2 cache is cold, each chunk is 1 NVIDIA API call.
 */

import { db } from '../src/lib/db'
import { generateEmbedding, getCurrentEmbeddingModelVersion } from '../src/lib/embeddings'
import { qdrant, COLLECTION_CHUNKS } from '../src/lib/qdrant'

interface ScrollPoint {
  id: string | number
  payload?: Record<string, unknown> | null
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const batchSizeArg = args.find(a => a.startsWith('--batch-size='))
  const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 100
  const maxArg = args.find(a => a.startsWith('--max='))
  const max = maxArg ? parseInt(maxArg.split('=')[1], 10) : 10000
  const paceArg = args.find(a => a.startsWith('--pace-ms='))
  const paceMs = paceArg ? parseInt(paceArg.split('=')[1], 10) : 50
  const onlyStale = args.includes('--only-stale')

  const currentVersion = await getCurrentEmbeddingModelVersion()
  console.log(`[ReEmbed] Current model version : ${currentVersion}`)
  console.log(`[ReEmbed] Dry run              : ${dryRun}`)
  console.log(`[ReEmbed] Batch size           : ${batchSize}`)
  console.log(`[ReEmbed] Max points to process: ${max}`)
  console.log(`[ReEmbed] Pace ms (between writes): ${paceMs}`)
  console.log(`[ReEmbed] Only stale?          : ${onlyStale}`)
  console.log('')

  let totalProcessed = 0
  let totalUpdated = 0
  let totalSkippedCurrent = 0
  let totalSkippedNoText = 0
  let totalFailed = 0

  // Scroll-based pagination using Qdrant's next_page_offset cursor.
  let offset: string | number | undefined = undefined

  while (totalProcessed < max) {
    if (dryRun && totalProcessed >= batchSize) {
      console.log('[ReEmbed] DRY RUN: stopping after first page. Re-run without --dry-run to actually re-embed.')
      break
    }

    const result = (await qdrant.scroll(COLLECTION_CHUNKS, {
      limit: batchSize,
      offset,
      with_payload: true,
      with_vector: false,
    })) as unknown as { points: ScrollPoint[]; next_page_offset?: string | number | null }

    if (!result?.points || result.points.length === 0) {
      console.log(`[ReEmbed] No more points after offset=${offset ?? '(start)'}. Done.`)
      break
    }

    console.log(`[ReEmbed] Fetched ${result.points.length} points at offset=${offset ?? '(start)'} — processing...`)

    for (const point of result.points) {
      if (totalProcessed >= max) {
        console.log(`[ReEmbed] Reached --max=${max} cap — stopping.`)
        break
      }
      totalProcessed++

      const payload = (point.payload || {}) as Record<string, unknown>
      const text = (payload.content as string) || (payload.text as string) || ''
      const existingVersion = payload.embedding_model_version as string | undefined

      if (!text) {
        console.warn(`[ReEmbed] Point ${point.id} has no text content — skipping`)
        totalSkippedNoText++
        continue
      }

      if (existingVersion === currentVersion) {
        totalSkippedCurrent++
        continue
      }

      if (dryRun) {
        console.log(
          `[ReEmbed] DRY RUN: would re-embed point ${point.id} (existing version: ${
            existingVersion || '(none — pre-Prop 4.1 chunk)'
          }, text snippet: "${text.slice(0, 60)}...")`
        )
        totalUpdated++
        continue
      }

      try {
        const { vector } = await generateEmbedding(text)
        if (vector.length === 0) {
          // Phase 6 SMOLAB P0.1 — all providers failed, no pseudo-hash fallback.
          console.warn(`[ReEmbed] Embedding failed for point ${point.id} (NVIDIA unreachable) — skipping`)
          totalFailed++
          continue
        }

        await qdrant.upsert(COLLECTION_CHUNKS, {
          wait: false,
          points: [
            {
              id: point.id,
              vector,
              payload: { ...payload, embedding_model_version: currentVersion },
            },
          ],
        })
        totalUpdated++

        if (paceMs > 0) {
          await new Promise(r => setTimeout(r, paceMs))
        }
      } catch (err) {
        console.error(`[ReEmbed] Failed point ${point.id}:`, err instanceof Error ? err.message : String(err))
        totalFailed++
      }
    }

    if (result.next_page_offset === null || result.next_page_offset === undefined) {
      console.log('[ReEmbed] Reached end of collection (next_page_offset is null).')
      break
    }
    offset = result.next_page_offset
  }

  console.log('')
  console.log('================ ReEmbed Summary ================')
  console.log(`  Processed              : ${totalProcessed}`)
  console.log(`  Updated (re-embedded)  : ${totalUpdated}`)
  console.log(`  Skipped (already current): ${totalSkippedCurrent}`)
  console.log(`  Skipped (no text)      : ${totalSkippedNoText}`)
  console.log(`  Failed (NVIDIA/err)   : ${totalFailed}`)
  console.log('=================================================')

  try {
    await db.$disconnect()
  } catch {
    // ignore
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[ReEmbed] Uncaught error:', err)
    process.exit(1)
  })
