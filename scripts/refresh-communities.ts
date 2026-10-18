/**
 * R39 — Community-detect refresh sau D0 9-shard re-ingestion (D0 doc §5.5,
 * USER DUYỆT 2026-10-18 "Duyệt từ 1 đến 3"). Chạy MỘT lần để làm mới toàn
 * đồ thị: Leiden trên entity graph (103K node sau D0), viết lại communityId
 * (bulk elementId chunk — TASK 52b), tái tạo collection theopus_communities
 * + embed summaries bằng lõi embed nemotron-3-embed-1b.
 *
 * Bằng chứng empirical §3 D0 doc: 84K node ~5 phút trên sandbox 4GB/2 core,
 * không OOM. Node tạo sau job Leiden trước (kể cả +6.149 node của D0) chưa
 * có communityId — lần chạy này phủ lại toàn bộ.
 *
 * Usage (pm2 wrapper scratch/r39-communities.sh tự source .env — bài học R38:
 * process nền trần trọi bị kill giữa chừng, pm2 là chỗ đứng đúng):
 *   set -a && source .env && set +a && bun scripts/refresh-communities.ts
 */
import { detectAndStoreCommunities } from '../src/lib/kb-routing/communities'

async function main() {
  console.log('[R39-Communities] Bắt đầu refresh toàn đồ thị sau D0 9 shard (user duyệt §5.5)...')
  const started = Date.now()
  const stats = await detectAndStoreCommunities()
  console.log(`[R39-Communities] HOÀN TẤT sau ${((Date.now() - started) / 1000).toFixed(0)}s`)
  console.log(
    `[R39-Communities] nodes=${stats.nodesProcessed} edges=${stats.edgesProcessed} ` +
    `isolatedSkipped=${stats.isolatedNodesSkipped} communitiesFound=${stats.communitiesFound} ` +
    `communitiesStored=${stats.communitiesStored} modularity=${stats.modularity} ` +
    `silhouette=${stats.silhouette} gamma=${stats.gammaSwept}`
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('[R39-Communities] THẤT BẠI:', err instanceof Error ? err.stack : String(err))
  process.exit(1)
})
