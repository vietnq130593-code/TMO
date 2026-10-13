// ROUND 3 AUDIT: Tìm bằng chứng "Opus đi thực thi tác vụ thay agents"
import { db } from '/home/z/tmo-app/src/lib/db'

async function main() {
  // 1. Các directive message Opus ban hành → job nào đã chạy với agent nào?
  const directives = await db.chatMessage.findMany({
    where: { role: 'user', metadata: { contains: '"opusDirective":true' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, sessionId: true, createdAt: true, metadata: true, content: true },
  })
  console.log(`\n=== TỔNG DIRECTIVE OPUS ĐÃ BAN HÀNH: ${directives.length} ===`)
  for (const d of directives) {
    let meta: any = {}
    try { meta = JSON.parse(d.metadata ?? '{}') } catch { /* ignore */ }
    // Lấy job theo messageId
    const job = await db.goalLoopJob.findFirst({ where: { messageId: d.id }, select: { id: true, status: true, input: true, completedAt: true, error: true } })
    let agentName = '(no job)'
    if (job) {
      try {
        const input = JSON.parse(job.input)
        agentName = input.agentName ?? input.jobInput?.agentName ?? '(?)'
      } catch { agentName = '(parse err)' }
    }
    console.log(`- ${d.createdAt.toISOString()} | decision=${meta.decision} | session=${d.sessionId.slice(0, 8)} | AGENT THỰC THI: ${agentName} | job=${job?.status ?? 'none'}`)
  }

  // 2. AgentRunRecord có run nào do "Opus" thực thi không?
  try {
    const runs = await db.agentRunRecord.findMany({
      where: { agentName: 'Opus' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, runRef: true, agentName: true, status: true, createdAt: true },
    })
    console.log(`\n=== AGENT RUNS DO OPUS THỰC THI: ${runs.length} (trong 20 gần nhất) ===`)
    for (const r of runs) console.log(`- ${r.createdAt.toISOString()} | ${r.runRef} | status=${r.status}`)
  } catch (e: any) { console.log('agentRunRecord query lỗi:', e?.message) }

  // 3. Session nào đang gắn với agentProfile = Opus?
  const opusProfile = await db.agentProfile.findUnique({ where: { name: 'Opus' }, select: { id: true } })
  if (opusProfile) {
    const sessions = await db.agentSession.findMany({
      where: { agentProfileId: opusProfile.id },
      select: { sessionId: true, title: true, opusReviewMode: true, updatedAt: true },
      take: 20, orderBy: { updatedAt: 'desc' },
    })
    console.log(`\n=== SESSION ĐANG GẮN AGENT OPUS LÀM EXECUTOR: ${sessions.length} ===`)
    for (const s of sessions) console.log(`- ${s.sessionId.slice(0, 12)} | mode=${s.opusReviewMode} | ${s.title ?? '(no title)'}`)
  }

  // 4. Toàn bộ GoalLoopJob gần đây: agent nào chạy?
  const jobs = await db.goalLoopJob.findMany({ orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, sessionId: true, messageId: true, status: true, input: true, createdAt: true, error: true } })
  console.log(`\n=== 30 GOAL-LOOP JOB GẦN NHẤT ===`)
  for (const j of jobs) {
    let agentName = '?'
    let src = 'user'
    try {
      const input = JSON.parse(j.input)
      agentName = input.agentName ?? input.jobInput?.agentName ?? '?'
      const um: string = input.userMessage ?? input.jobInput?.userMessage ?? ''
      src = um.includes('OPUS — CHỈ ĐẠO') ? 'OPUS-DIRECTIVE' : 'user'
    } catch { /* ignore */ }
    console.log(`- ${j.createdAt.toISOString()} | ${j.status.padEnd(10)} | agent=${String(agentName).padEnd(10)} | src=${src} | ${j.error ? 'ERR: ' + j.error.slice(0, 80) : ''}`)
  }

  // 5. OpusReview gần đây
  const reviews = await db.opusReview.findMany({ orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, sessionId: true, decision: true, triggerMode: true, createdAt: true, model: true } })
  console.log(`\n=== 15 OPUS REVIEW GẦN NHẤT ===`)
  for (const r of reviews) {
    console.log(`- ${r.createdAt.toISOString()} | ${r.decision} | mode=${r.triggerMode} | model=${r.model}`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
