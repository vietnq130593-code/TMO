/**
 * INSPECT ONLY — rà soát hậu triển khai ALISTA v1.3 (không ghi gì cả).
 * Kiểm tra: proposals [ALISTA], defer markers, zombie rows, cron nextRunAt.
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient({
  datasources: { db: { url: 'file:/home/z/tmo-app/db/custom.db' } },
})

async function main() {
  const now = new Date()
  console.log('=== NOW (UTC):', now.toISOString(), '| VN:', now.toLocaleString('vi-VN', { timeZone: 'Etc/GMT-7' }))

  // 1) ALISTA proposals
  const alistap = await db.selfDirectionProposal.findMany({
    where: { OR: [{ title: { contains: 'ALISTA' } }, { createdBy: { contains: 'alista' } }] },
    orderBy: { createdAt: 'asc' },
  })
  console.log(`\n=== [ALISTA] PROPOSALS: ${alistap.length}`)
  for (const p of alistap) {
    console.log(`- [${p.status}] ${p.title.slice(0, 90)} | prio=${p.priority} | src=${p.source} | created=${p.createdAt.toISOString()} | completed=${p.completedAt?.toISOString() ?? '-'} | id=${p.id}`)
  }
  // Any E2E test leftovers?
  const e2e = await db.selfDirectionProposal.findMany({
    where: { OR: [{ title: { contains: 'E2E' } }, { title: { contains: 'TEST' } }, { problem: { contains: 'E2E' } }] },
  })
  console.log(`\n=== E2E/TEST LEFTOVER PROPOSALS: ${e2e.length}`)
  for (const p of e2e) console.log(`- [${p.status}] ${p.title.slice(0, 100)} | id=${p.id}`)

  // 2) Defer markers
  const markers = await db.taskExecution.findMany({
    where: { type: { contains: 'alista' } },
    orderBy: { startedAt: 'desc' },
    take: 30,
  })
  console.log(`\n=== ALISTA TaskExecution rows (mới nhất 30): ${markers.length}`)
  for (const m of markers) {
    const res = m.result ? JSON.parse(m.result) : null
    const due = res?.dueAt ? new Date(res.dueAt) : null
    const overdue = due && due < now && m.status === 'pending' ? ' ⚠️ ĐÃ ĐẾN HẠN' : ''
    console.log(`- type=${m.type} status=${m.status} started=${m.startedAt.toISOString()} due=${due?.toISOString() ?? '-'}${overdue} | jobId=${m.jobId ?? '-'} | result=${(m.result ?? '').slice(0, 120)}`)
  }

  // 3) Zombies: running > 30'
  const zombies = await db.taskExecution.findMany({
    where: { status: 'running', startedAt: { lt: new Date(now.getTime() - 30 * 60 * 1000) } },
    take: 10,
  })
  console.log(`\n=== ZOMBIE 'running' TaskExecution (>30'): ${zombies.length}`)
  for (const z of zombies) console.log(`- type=${z.type} started=${z.startedAt.toISOString()}`)

  // 4) CronJob alista
  const crons = await db.cronJob.findMany({
    where: { OR: [{ taskPrompt: { contains: 'alista' } }, { task: { contains: 'alista' } }, { agentId: { contains: 'alista' } }] },
  })
  console.log(`\n=== ALISTA CronJobs: ${crons.length}`)
  for (const c of crons) {
    const late = c.enabled && c.nextRunAt && c.nextRunAt < new Date(now.getTime() - 3600 * 1000) ? ' ⚠️ TRỄ >1h' : ''
    console.log(`- id=${c.id} enabled=${c.enabled} status=${c.status} expr=${c.expr || c.expression} tz=${c.tz ?? '-'} executor='${c.executor}' nextRunAt=${c.nextRunAt?.toISOString() ?? '-'}${late} lastRunAt=${c.lastRunAt?.toISOString() ?? '-'} retry=${c.retryCount}/${c.maxRetries} lastError=${c.lastError ?? '-'}`)
    console.log(`  task=${(c.task || c.taskPrompt).slice(0, 110)}`)
  }

  // 5) SelfDirection settings + recent non-alista proposals (context)
  const recent = await db.selfDirectionProposal.count({ where: { createdAt: { gt: new Date(now.getTime() - 48 * 3600 * 1000) } } })
  const total = await db.selfDirectionProposal.count({})
  console.log(`\n=== Tổng proposals: ${total} (mới 48h: ${recent})`)
  const byStatus = await db.selfDirectionProposal.groupBy({ by: ['status'], _count: true })
  console.log('=== By status:', JSON.stringify(byStatus.map(s => `${s.status}=${s._count}`)))

  // 6) ALISTA agent exists + instruction v1.3?
  const agents = await db.agentProfile.findMany({ where: { OR: [{ name: { contains: 'ALISTA' } }, { name: { contains: 'alista' } }] } })
  console.log(`\n=== ALISTA agents: ${agents.length}`)
  for (const a of agents) {
    const has13 = a.instruction?.includes('v1.3') || a.instruction?.includes('6/6') || a.instruction?.includes('tiêu chí')
    console.log(`- name=${a.name} enabled=${a.enabled} instructionLen=${a.instruction?.length ?? 0} mentionsCriteria=${has13}`)
  }
}

main()
  .catch(e => { console.error('INSPECT FAILED:', e); process.exit(1) })
  .finally(() => db.$disconnect())
