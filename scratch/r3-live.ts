import { db } from '/home/z/tmo-app/src/lib/db'
async function main() {
  const last = await db.agentRunRecord.findFirst({ where: { agentName: 'Opus' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, status: true, runId: true } })
  console.log('LAST opus run:', last?.createdAt.toISOString(), last?.status, last?.runId)
  const cnt30m = await db.agentRunRecord.count({ where: { agentName: 'Opus', createdAt: { gt: new Date(Date.now() - 30 * 60_000) } } })
  console.log('opus runs 30 phút qua:', cnt30m)
  const all = await db.agentRunRecord.findMany({ where: { agentName: 'Opus', createdAt: { gt: new Date(Date.now() - 3 * 3600_000) } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true, status: true } })
  for (const r of all) console.log(' -', r.createdAt.toISOString().slice(11, 19), r.status)
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
