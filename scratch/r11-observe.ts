/**
 * R11 — LƯỢT QUAN SÁT THỨ 5 (2026-10-14)
 * Mục đích: tái hiện dòng sự kiện của phiên chat user (sess_1791976994112_ejzmer)
 * + toàn bộ runs/subagents/goal-loop/observation events liên quan.
 * READ-ONLY — không ghi gì vào DB.
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

function j(x: unknown, max = 600) {
  const s = JSON.stringify(x, (_k, v) => (typeof v === 'string' && v.length > 220 ? v.slice(0, 220) + '…' : v))
  return (s ?? 'null').slice(0, max)
}

async function main() {
  const T0 = new Date('2026-10-14T10:30:00.000Z').getTime()

  console.log('========== 1. AGENT SESSIONS hoạt động gần đây ==========')
  const sessions = await db.agentSession.findMany({
    where: { updatedAt: { gte: new Date(T0) } },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  })
  for (const s of sessions) {
    console.log(`- ${s.id} | agent=${s.agentId} | title=${j(s.title, 120)} | updated=${s.updatedAt.toISOString()}`)
  }

  console.log('\n========== 2. CHAT MESSAGES từ 10:30 UTC (dòng sự kiện user) ==========')
  const msgs = await db.chatMessage.findMany({
    where: { createdAt: { gte: new Date(T0) } },
    orderBy: { createdAt: 'asc' },
    take: 40,
  })
  for (const m of msgs) {
    console.log(`- [${m.createdAt.toISOString()}] sess=${m.sessionId?.slice(-8)} role=${m.role} | ${j(m.content, 400)}`)
  }

  console.log('\n========== 3. AGENT RUN RECORDS gần đây (15) ==========')
  const runs = await db.agentRunRecord.findMany({
    orderBy: { startedAt: 'desc' },
    take: 15,
  })
  for (const r of runs) {
    console.log(
      `- ${r.id} | ${r.agentName} | sess=${r.sessionId?.slice(-8)} | status=${r.status} complete=${r.complete} | cycles=${(r as any).cycles ?? (r as any).cycleCount} | tokens=${(r as any).tokensUsed} | ${r.startedAt?.toISOString?.()} → ${(r as any).completedAt?.toISOString?.() ?? '-'} | dur=${(r as any).durationMs}ms | err=${j((r as any).errorInfo ?? (r as any).error, 200)}`,
    )
  }

  console.log('\n========== 4. TODOS phiên user ==========')
  const todos = await db.todo.findMany({
    where: { OR: [{ sessionId: 'sess_1791976994112_ejzmer' }, { updatedAt: { gte: new Date(T0) } }] },
    orderBy: { updatedAt: 'desc' },
    take: 25,
  })
  for (const t of todos) {
    console.log(`- [${t.updatedAt.toISOString()}] ${t.status} | ${j(t.content, 150)} | run=${(t as any).runId ?? ''} sess=${t.sessionId?.slice(-8)}`)
  }

  console.log('\n========== 5. GOAL LOOP JOBS ==========')
  const jobs = await db.goalLoopJob.findMany({ orderBy: { updatedAt: 'desc' }, take: 8 })
  for (const jb of jobs) {
    let goal = ''
    try { goal = j(JSON.parse(jb.input)?.goal ?? jb.input, 200) } catch { goal = j(jb.input, 200) }
    console.log(`- ${jb.id} | status=${jb.status} | cyclesDone=${jb.cyclesDone} attempts=${jb.attempts} stop=${jb.stopReason ?? '-'} | sess=${jb.sessionId?.slice(-8)} | goal=${goal} | created=${jb.createdAt.toISOString()} updated=${jb.updatedAt.toISOString()} hb=${jb.heartbeatAt?.toISOString?.() ?? '-'} | err=${j(jb.error, 150)}`)
  }

  console.log('\n========== 6. OBSERVATION EVENTS từ 10:30 ==========')
  const events = await db.observationEvent.findMany({
    where: { createdAt: { gte: new Date(T0) } },
    orderBy: { createdAt: 'asc' },
    take: 60,
  })
  for (const e of events) {
    console.log(`- [${e.createdAt.toISOString()}] ${e.kind} | ${j(e.summary ?? (e as any).title, 260)}`)
  }

  console.log('\n========== 7. ARBITER VERDICTS gần đây ==========')
  const verdicts = await db.arbiterVerdict.findMany({ orderBy: { createdAt: 'desc' }, take: 6 })
  for (const v of verdicts) {
    console.log(`- [${v.createdAt.toISOString()}] run=${(v as any).runId} | complete=${v.complete} | decision=${j((v as any).decision ?? (v as any).verdict, 100)} | score=${j((v as any).score, 100)} | ${j((v as any).summary ?? (v as any).reasoning, 300)}`)
  }

  console.log('\n========== 8. WORKSPACE (nghi vấn path-escape) ==========')
  const ws = await db.workspace.findMany({ take: 10 })
  for (const w of ws) {
    console.log(`- id=${w.id} | name=${j(w.name, 100)} | rootPath=${j(w.rootPath, 150)} | isActive=${w.isActive}`)
  }

  console.log('\n========== 9. TOKEN USAGE THEO AGENT HÔM NAY ==========')
  const byAgent = await db.dailyTokenByAgent.findMany({ where: { date: '2026-10-14' }, orderBy: { tokens: 'desc' }, take: 15 })
  for (const a of byAgent) {
    console.log(`- ${a.agentName} | ${a.provider}/${a.model} | tokens=${a.tokens} (in ${a.inputTokens}/out ${a.outputTokens})`)
  }
  const total = await db.dailyTokenUsage.findMany({ orderBy: { date: 'desc' }, take: 3 })
  for (const t of total) console.log(`- TOTAL ${j(t, 200)}`)

  console.log('\n========== 10. LESSONS MỚI SINH TRONG PHIÊN (10:30+) ==========')
  const lessons = await db.lessonRecord.findMany({
    where: { createdAt: { gte: new Date(T0) } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  for (const l of lessons) {
    console.log(`- [${l.createdAt.toISOString()}] ${j((l as any).title ?? (l as any).lesson, 200)} | origin=${j((l as any).origin ?? (l as any).source, 80)}`)
  }

  console.log('\n========== 11. BRAIN / HYPERNAS TRẠNG THÁI ==========')
  const brains = await db.brainModel.findMany({ take: 10 })
  for (const b of brains) {
    console.log(`- brain=${j((b as any).name ?? (b as any).brainId, 80)} | stage=${j((b as any).stage, 60)} | version=${(b as any).version} | trainedAt=${j((b as any).trainedAt, 40)}`)
  }
  const bsr = await db.brainSearchRun.count()
  const bsc = await db.brainSearchCandidate.count()
  const obsFlags = await db.observationEvent.groupBy({ by: ['kind'], _count: true }).catch(() => [])
  console.log(`- BrainSearchRun tổng: ${bsr} | Candidate tổng: ${bsc}`)
  console.log(`- Observation kinds: ${j(obsFlags, 400)}`)
}

main()
  .catch((e) => {
    console.error('LỖI:', e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
