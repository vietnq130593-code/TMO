import { db } from '/home/z/tmo-app/src/lib/db'

async function main() {
  // 1. AgentRunRecord do Opus thực thi (field đúng: runId)
  const runs = await db.agentRunRecord.findMany({
    where: { agentName: 'Opus' },
    orderBy: { createdAt: 'desc' }, take: 30,
    select: { id: true, runId: true, status: true, createdAt: true, sessionId: true, model: true, cycles: true, toolCalls: true, tokensUsed: true, complete: true, stopReason: true },
  })
  console.log(`\n=== AGENT RUNS THỰC THI BỞI OPUS: ${runs.length} ===`)
  for (const r of runs) console.log(`- ${r.createdAt.toISOString()} | run=${String(r.runId).slice(0,24)} | ${r.status} | cycles=${r.cycles} toolCalls=${r.toolCalls} tokens=${r.tokensUsed} | model=${r.model} | sess=${String(r.sessionId).slice(0,10)}`)

  // 2. Session Opus: đọc lịch sử chat xem Opus đã làm gì
  const opusProfile = await db.agentProfile.findUnique({ where: { name: 'Opus' }, select: { id: true } })
  const sessions = await db.agentSession.findMany({ where: { agentProfileId: opusProfile!.id }, orderBy: { updatedAt: 'desc' } })
  for (const s of sessions) {
    console.log(`\n=== SESSION ${s.sessionId} | "${s.title}" | mode=${s.opusReviewMode} | msgs=${s.messageCount} ===`)
    const msgs = await db.chatMessage.findMany({ where: { sessionId: s.sessionId }, orderBy: { createdAt: 'asc' }, select: { role: true, content: true, createdAt: true, metadata: true } })
    for (const m of msgs) {
      const head = m.content.replace(/\n/g, ' ').slice(0, 110)
      let tag = ''
      try {
        const meta = JSON.parse(m.metadata ?? '{}')
        if (meta.opusDirective) tag = ' [OPUS-DIRECTIVE]'
        if (meta.opusReview) tag += ' [OPUS-REVIEW]'
      } catch { /* ignore */ }
      console.log(`  ${m.createdAt.toISOString().slice(11,19)} ${m.role.padEnd(9)}${tag}: ${head}`)
    }
    // Runs của session này (bất kể agent)
    const sruns = await db.agentRunRecord.findMany({ where: { sessionId: s.sessionId }, orderBy: { createdAt: 'asc' }, select: { runId: true, agentName: true, status: true, createdAt: true, cycles: true, toolCalls: true, stopReason: true, complete: true } })
    console.log(`  --- RUNS của session: ${sruns.length} ---`)
    for (const r of sruns) console.log(`    ${r.createdAt.toISOString().slice(11,19)} run=${String(r.runId).slice(0,24)} agent=${r.agentName} ${r.status} cycles=${r.cycles} tools=${r.toolCalls} complete=${r.complete}`)
  }

  // 3. Phân bổ runs theo agent toàn hệ thống
  const all = await db.agentRunRecord.findMany({ select: { agentName: true } })
  const byAgent = new Map<string, number>()
  for (const r of all) byAgent.set(r.agentName, (byAgent.get(r.agentName) ?? 0) + 1)
  console.log(`\n=== PHÂN BỔ RUNS THEO AGENT ===`)
  for (const [name, count] of [...byAgent.entries()].sort((a, b) => b[1] - a[1])) console.log(`- ${name}: ${count}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
