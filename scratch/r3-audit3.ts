import { db } from '/home/z/tmo-app/src/lib/db'
async function main() {
  // 1. Full sessionId của các run opus_rev + mode của session đó
  const runs = await db.agentRunRecord.findMany({
    where: { agentName: 'Opus' },
    orderBy: { createdAt: 'desc' }, take: 100,
    select: { sessionId: true, createdAt: true, status: true, stopReason: true },
  })
  const bySession = new Map<string, number>()
  for (const r of runs) bySession.set(r.sessionId, (bySession.get(r.sessionId) ?? 0) + 1)
  console.log('=== OPUS REV RUNS THEO SESSION ===')
  for (const [sid, count] of bySession) {
    const s = await db.agentSession.findUnique({ where: { sessionId: sid }, select: { title: true, opusReviewMode: true, agentProfileId: true, createdAt: true } })
    let agentName = '?'
    if (s?.agentProfileId) { const p = await db.agentProfile.findUnique({ where: { id: s.agentProfileId }, select: { name: true } }); agentName = p?.name ?? '?' }
    console.log(`- ${sid} | count=${count} | mode=${s?.opusReviewMode} | agent=${agentName} | title="${s?.title}"`)
  }
  // 2. Runs trong 24h cuối: status breakdown + khoảng cách
  const last = runs.slice(0, 40).reverse()
  console.log('\n=== 40 RUN CUỐI (cũ→mới): thời gian + status ===')
  let prev: number | null = null
  for (const r of last) {
    const gap = prev ? Math.round((r.createdAt.getTime() - prev) / 1000) : 0
    prev = r.createdAt.getTime()
    console.log(`- ${r.createdAt.toISOString().slice(11,19)} ${r.status} (gap ${gap}s trước đó) stop=${r.stopReason}`)
  }
  // 3. Đếm OpusReview theo session
  const reviews = await db.opusReview.findMany({ select: { sessionId: true, createdAt: true, decision: true, triggerMode: true } })
  console.log(`\n=== TỔNG OPUS REVIEW ROWS: ${reviews.length} ===`)
  for (const rv of reviews) console.log(`- ${rv.createdAt.toISOString()} | ${rv.decision} | ${rv.triggerMode} | sess=${rv.sessionId.slice(0, 20)}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
