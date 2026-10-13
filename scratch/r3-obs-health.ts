import { db } from '/home/z/tmo-app/src/lib/db'
async function main() {
  // KPI snapshots 24h
  const kpi = await db.kpiSnapshot.count({ where: { createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } } })
  console.log('KpiSnapshot 24h:', kpi)
  // ObservationEvent kinds 6h qua
  const evs = await db.observationEvent.findMany({ where: { createdAt: { gt: new Date(Date.now() - 6 * 3600_000) } }, select: { kind: true } })
  const byKind = new Map<string, number>()
  for (const e of evs) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1)
  console.log('ObservationEvent 6h qua theo kind:', JSON.stringify([...byKind.entries()]))
  // HyperNAS search sessions
  try {
    const hn = await db.brainArchitectureSearchSession.count()
    console.log('HyperNAS search sessions (tổng):', hn)
  } catch (e: any) { console.log('HN session query:', e?.message?.slice(0, 80)) }
  // Brain weights + traces
  const traces = await db.brainInferenceTrace.count({ where: { createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } } })
  console.log('BrainInferenceTrace 24h:', traces)
  // DB integrity
  const jobs = await db.goalLoopJob.findMany({ select: { status: true } })
  const byStatus = new Map<string, number>()
  for (const j of jobs) byStatus.set(j.status, (byStatus.get(j.status) ?? 0) + 1)
  console.log('GoalLoopJob theo status:', JSON.stringify([...byStatus.entries()]))
  const stuck = await db.agentRunRecord.count({ where: { status: 'running', createdAt: { lt: new Date(Date.now() - 30 * 60_000) } } })
  console.log('AgentRunRecord kẹt running >30p (sau cleanup):', stuck)
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
