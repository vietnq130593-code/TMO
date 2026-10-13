import { db } from '/home/z/tmo-app/src/lib/db'
async function main() {
  const runs = await db.brainSearchRun.count()
  const cands = await db.brainSearchCandidate.count()
  console.log('HyperNAS BrainSearchRun:', runs, '| BrainSearchCandidate:', cands)
  const recent = await db.brainSearchRun.findMany({ orderBy: { createdAt: 'desc' }, take: 3, select: { createdAt: true, brain: true, status: true } })
  for (const r of recent) console.log(' -', r.createdAt.toISOString(), r.brain, r.status)
  // Qdrant re-embed progress (ALISTA) — check embedding pipeline logs gần đây
  const eps = await db.observationEvent.findMany({ where: { kind: 'db.write', createdAt: { gt: new Date(Date.now() - 6 * 3600_000) } }, take: 3, orderBy: { createdAt: 'desc' }, select: { summary: true, createdAt: true } })
  console.log('db.write 6h (mẫu):', eps.length ? eps.map(e => e.summary.slice(0, 80)) : '(trống)')
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
