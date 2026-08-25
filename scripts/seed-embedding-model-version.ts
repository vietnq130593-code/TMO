/**
 * Phase 3 SMOLAB Proposal 4.1 — Seed the active EmbeddingModelVersion row.
 *
 * Idempotent: inserts today's version row if missing, marks previous rows
 * for the same modelName as deprecated. Run once after any DB reset, BEFORE
 * reembed-all.ts (so reembed stamps the correct version tag).
 *
 * Usage:
 *   cd /home/z/tmo-app && bunx tsx scripts/seed-embedding-model-version.ts
 *   # Override the version tag (e.g. after an NVIDIA silent model update):
 *   SEED_VERSION_TAG=2025-XX-XX bunx tsx scripts/seed-embedding-model-version.ts
 */

import { db } from '../src/lib/db'

async function main() {
  const modelName = process.env.NVIDIA_EMBED_MODEL || 'nvidia/llama-nemotron-embed-1b-v2'
  const dimensions = process.env.NVIDIA_EMBED_DIMENSIONS || '2048'
  const versionTag = process.env.SEED_VERSION_TAG || new Date().toISOString().slice(0, 10)

  console.log(`[SeedEmbedVersion] modelName=${modelName}, versionTag=${versionTag}, dims=${dimensions}`)

  // Existing active row for this model?
  const existing = await db.embeddingModelVersion.findFirst({
    where: { modelName, deprecatedAt: null },
    orderBy: { activeSince: 'desc' },
  })

  if (existing && existing.versionTag === versionTag) {
    console.log(`[SeedEmbedVersion] Active row already exists: ${modelName}@${versionTag} (id=${existing.id}) — nothing to do`)
    return
  }

  // Mark existing active rows as deprecated
  if (existing) {
    await db.embeddingModelVersion.update({
      where: { id: existing.id },
      data: { deprecatedAt: new Date() },
    })
    console.log(`[SeedEmbedVersion] Deprecated previous active: ${modelName}@${existing.versionTag}`)
  }

  // Insert (or find) the new row
  const row = await db.embeddingModelVersion.upsert({
    where: { modelName_versionTag: { modelName, versionTag } },
    create: {
      modelName,
      versionTag,
      config: JSON.stringify({ dimensions: parseInt(dimensions, 10), similarity: 'cosine' }),
    },
    update: { deprecatedAt: null },
  })

  console.log(`[SeedEmbedVersion] Active version seeded: ${modelName}@${versionTag} (id=${row.id})`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[SeedEmbedVersion] FAILED:', err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
