// ROUND-44 monitor — poll goal-loop job + code team workflow state từ DB (bun:sqlite)
import { Database } from 'bun:sqlite'

const db = new Database('/home/z/tmo-app/db/custom.db', { readonly: true })
const JOB = process.argv[2]
const seenWorklogs = new Set<string>()

function q<T = unknown>(sql: string): T[] { return db.prepare(sql).all() as T[] }

let lastHint = ''
for (let i = 0; i < 240; i++) {
  const job = q<{ status: string; cyclesDone: number; stopReason: string | null }>(
    `SELECT status, cyclesDone, stopReason FROM GoalLoopJob WHERE id='${JOB}'`)[0]
  const wf = q<{ sessionId: string; currentStep: string; currentAgent: string | null; completedAgents: string }>(
    `SELECT sessionId, currentStep, currentAgent, completedAgents FROM CodeTeamSession WHERE updatedAt > datetime('now', '-2 hours') ORDER BY updatedAt DESC LIMIT 3`)
  const logs = q<{ id: string; sessionId: string; agentName: string; position: string; step: string; duration: number; toolCalls: string }>(
    `SELECT id, sessionId, agentName, position, step, duration, toolCalls FROM CodeTeamWorklog ORDER BY createdAt DESC LIMIT 8`)
  const now = new Date().toISOString().slice(11, 19)
  const hint = job?.stopReason || ''
  if (hint !== lastHint || i % 4 === 0) {
    console.log(`[${now}] job=${job?.status} cycles=${job?.cyclesDone} stop=${hint}`)
    lastHint = hint
  }
  for (const w of logs) {
    if (!seenWorklogs.has(w.id)) {
      seenWorklogs.add(w.id)
      const tc = (() => { try { return JSON.parse(w.toolCalls || '[]').length } catch { return 0 } })()
      console.log(`  🆙 STEP-DONE ${w.position}/${w.step} agent=${w.agentName} dur=${Math.round((w.duration || 0) / 1000)}s toolCallsPersisted=${tc} [${w.sessionId.slice(0, 26)}]`)
    }
  }
  for (const s of wf) {
    console.log(`  ▶ WF ${s.sessionId.slice(0, 30)} step=${s.currentStep} agent=${s.currentAgent || '-'} completed=[${s.completedAgents}]`)
  }
  if (job && ['completed', 'failed', 'cancelled'].includes(job.status)) {
    console.log(`\n[${now}] JOB TERMINAL: ${job.status}`)
    const finalLogs = q<{ position: string; step: string; agentName: string; duration: number; toolCalls: string }>(
      `SELECT position, step, agentName, duration, toolCalls FROM CodeTeamWorklog WHERE sessionId=(SELECT sessionId FROM CodeTeamSession ORDER BY updatedAt DESC LIMIT 1) ORDER BY createdAt`)
    for (const f of finalLogs) {
      const tc = (() => { try { return JSON.parse(f.toolCalls || '[]').length } catch { return 0 } })()
      console.log(`  FINAL ${f.position}/${f.step} ${f.agentName} ${Math.round((f.duration || 0) / 1000)}s tools=${tc}`)
    }
    break
  }
  await new Promise(r => setTimeout(r, 15000))
}
db.close()
