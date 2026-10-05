/**
 * ROUND-36 (rà soát lượt 3, B-Y-4) — Vận hành hoá drift detection (Prop 4.1).
 *
 * BỐI CẢNH: EmbeddingModelVersion table = 0 rows + chunk points không có
 * payload embedding_model_version (chỉ writeback/auto-learn stamp) →
 * getCurrentEmbeddingModelVersion() luôn fallback '@unknown' và
 * checkModelDrift() warn "run scripts/reembed-all.ts" trên MỌI KB search —
 * phát hiện model-drift (mục đích thật của Prop 4.1) chưa từng chạy đúng.
 *
 * Heal 2 phần (idempotent, không gọi embed API):
 *  1) Seed EmbeddingModelVersion active row nếu trống (logic khớp
 *     scripts/seed-embedding-model-version.ts — chuẩn hoá về 1 nguồn).
 *  2) Stamp payload embedding_model_version cho chunk point còn thiếu
 *     (scroll + setPayload theo batch id — vector/payload khác giữ nguyên).
 * Tầng phòng tránh tái diễn: qdrant.upsertChunks() giờ tự stamp mọi chunk
 * mới (xem qdrant.ts) — module này chỉ dọn nợ tồn đọng.
 */

import { db } from '@/lib/db'
import { qdrant } from '@/lib/qdrant'
import { getCurrentEmbeddingModelVersion } from '@/lib/embeddings'

/** Seed active EmbeddingModelVersion row nếu chưa có — trả true khi đã seed */
export async function seedActiveEmbeddingModelVersion(): Promise<{ seeded: boolean; tag: string }> {
  const modelName = process.env.NVIDIA_EMBED_MODEL || 'nvidia/llama-nemotron-embed-1b-v2'
  const dimensions = parseInt(process.env.NVIDIA_EMBED_DIMENSIONS || '2048', 10)
  const versionTag = new Date().toISOString().slice(0, 10)

  const existing = await db.embeddingModelVersion.findFirst({
    where: { modelName, deprecatedAt: null },
    orderBy: { activeSince: 'desc' },
  }).catch(() => null)

  if (existing) return { seeded: false, tag: `${existing.modelName}@${existing.versionTag}` }

  await db.embeddingModelVersion.create({
    data: {
      modelName,
      versionTag,
      config: JSON.stringify({ dimensions: Number.isFinite(dimensions) ? dimensions : 2048, similarity: 'cosine' }),
    },
  }).catch(async (err) => {
    // Rare race: create đè unique (modelName, versionTag) từ process khác →
    // deposit/deprecate vẫn nhất quán vì findFirst đã chạy — chỉ log.
    console.warn('[DriftHeal] seed create race (bỏ qua — đã có row):', err instanceof Error ? err.message : String(err))
  })
  return { seeded: true, tag: `${modelName}@${versionTag}` }
}

/** Stamp embedding_model_version cho chunk point còn thiếu — trả số point đã stamp */
export async function stampChunkModelVersions(): Promise<{ stamped: number; total: number }> {
  const currentVersion = await getCurrentEmbeddingModelVersion()
  const missingIds: Array<string | number> = []
  let total = 0
  try {
    let offset: string | number | undefined = undefined
    do {
      const res = await qdrant.scroll('theopus_chunks', {
        limit: 256,
        offset,
        with_payload: true,
        with_vector: false,
      })
      for (const p of res.points) {
        total++
        const version = (p.payload as Record<string, unknown> | null)?.embedding_model_version
        if (!version) missingIds.push(p.id)
      }
      offset = (res.next_page_offset as string | number | undefined) ?? undefined
    } while (offset)
  } catch {
    return { stamped: 0, total }
  }

  // setPayload theo batch 100 — chỉ THÊM field, mọi field khác nguyên vẹn
  for (let i = 0; i < missingIds.length; i += 100) {
    const batch = missingIds.slice(i, i + 100)
    try {
      await qdrant.setPayload('theopus_chunks', {
        payload: { embedding_model_version: currentVersion },
        points: batch,
        wait: true,
      })
    } catch (err) {
      console.warn('[DriftHeal] setPayload batch fail (bỏ qua — lần boot sau thử lại):', err instanceof Error ? err.message : String(err))
    }
  }
  return { stamped: missingIds.length, total }
}

/**
 * Boot wrapper — rẻ (0 embed call), chạy 1 lần mỗi process.
 * Trả về vì sao chạy hay skip để instrumentation log đúng sự thật.
 */
export async function maybeHealModelVersionTracking(): Promise<{ ran: boolean; reason: string }> {
  const g = globalThis as unknown as { __tmoDriftHealDone?: boolean }
  if (g.__tmoDriftHealDone) return { ran: false, reason: 'already done this process' }
  g.__tmoDriftHealDone = true
  try {
    const seed = await seedActiveEmbeddingModelVersion()
    const stamp = await stampChunkModelVersions()
    const reason = `modelVersion=${seed.tag}${seed.seeded ? ' (seeded mới)' : ''}, chunks=${stamp.total}, stamped=${stamp.stamped}`
    if (seed.seeded || stamp.stamped > 0) {
      console.log(`[DriftHeal] Heal model-version tracking: ${reason}`)
    }
    return { ran: seed.seeded || stamp.stamped > 0, reason }
  } catch (err) {
    console.warn('[DriftHeal] failed (fail-open):', err instanceof Error ? err.message : String(err))
    return { ran: false, reason: `error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
