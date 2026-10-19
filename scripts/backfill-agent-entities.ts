/**
 * EXECUTION-EFFICIENCY S1.2 — BACKFILL 1 LẦN: write-through mọi entity agent
 * lịch sử lên Neo4j (blueprint P1/S1, r43 hiệu đính #9).
 *
 * Vì sao: trước S1, knowledge_write của agent ghi LocalEntity synced=false vào
 * "buffer mù" — không đường sync nào (doc-scope theo documentId, entity agent
 * có documentId=null) cũng không đường search nào đọc nó. S1.1 vá write MỚI
 * (write-through ngay trong tool call); KHÔNG backfill thì 6 entity của run
 * bằng chứng run_1792386145100_1 (ALISTA, 05:13–05:20 19/10) vẫn vô hình với
 * knowledge_graph sau deploy.
 *
 * Idempotent: chạy nhiều lần an toàn (MERGE theo node id deterministic
 * global__<name>__<type>; entity đã synced:true bị bỏ qua).
 *
 * Usage (source .env như mọi script chạy nền của repo):
 *   set -a && source .env && set +a && bun scripts/backfill-agent-entities.ts
 */
import { writeThroughEntityToGraph } from '../src/lib/knowledge-bridge'

async function main() {
  // Import sau khi env đã nạp (PrismaClient đọc DATABASE_URL từ env)
  const { db } = await import('../src/lib/db')

  const pending = await db.localEntity.findMany({
    where: { documentId: null, synced: false },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`[S1.2-Backfill] Tìm thấy ${pending.length} entity agent chưa sync (documentId=null, synced=false)`)

  if (pending.length === 0) {
    console.log('[S1.2-Backfill] Không có gì để làm — thoát.')
    process.exit(0)
  }

  let ok = 0
  let degraded = 0
  let firstOkName: string | null = null
  for (const e of pending) {
    const res = await writeThroughEntityToGraph(e)
    if (res.ok) {
      ok++
      if (!firstOkName) firstOkName = e.entityName
      console.log(`[S1.2-Backfill] ✓ "${e.entityName.slice(0, 80)}" → node ${res.graphNodeId}`)
    } else {
      degraded++
      console.warn(`[S1.2-Backfill] ✗ "${e.entityName.slice(0, 80)}" — ${res.error} (giữ buffer, chạy lại sau)`)
    }
  }

  console.log(`[S1.2-Backfill] HOÀN TẤT: ${ok} write-through thành công, ${degraded} degraded (Neo4j lỗi — giữ buffer, chạy lại script sau)`)
  // Nghiệm thu S1 trên chính dữ liệu thật: verify search thấy chưa
  if (firstOkName) {
    const { agentKnowledgeSearch } = await import('../src/lib/knowledge-bridge')
    const probe = await agentKnowledgeSearch(firstOkName.slice(0, 60), { topK: 5 })
    const found = probe.results.some(r => r.entityName === firstOkName)
    console.log(`[S1.2-Backfill] VERIFY search "${firstOkName.slice(0, 60)}": ${found ? 'TÌM THẤY ✓ (KPI §6 đạt)' : 'KHÔNG thấy ✗ — kiểm tra S1.3 LIKE layer'}`)
  }
  process.exit(0)
}

main().catch(err => {
  console.error('[S1.2-Backfill] FATAL:', err)
  process.exit(1)
})
