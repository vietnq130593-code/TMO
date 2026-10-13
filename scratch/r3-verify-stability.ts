import { db } from '/home/z/tmo-app/src/lib/db'
async function main() {
  const alerts = await db.observationEvent.findMany({
    where: { kind: 'obs.alert', createdAt: { gt: new Date(Date.now() - 15 * 60_000) } },
    orderBy: { createdAt: 'desc' }, take: 3,
    select: { createdAt: true, summary: true, payloadJson: true },
  })
  console.log('obs.alert 15 phút qua:', alerts.length)
  for (const l of alerts) {
    console.log(' -', l.createdAt.toISOString(), '|', l.summary)
    try { const p = JSON.parse(l.payloadJson ?? '{}'); if (p.rule) console.log('   rule:', p.rule, '| failures:', p.consecutiveFailures, '| protocol:', p.protocol) } catch { /* ignore */ }
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
