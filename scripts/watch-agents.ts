/**
 * WATCH-AGENTS — Trạm quan sát vận hành agents (Task 54)
 * Chạy: bun scripts/watch-agents.ts [--since-min N]
 * (Task 55: tự chuẩn hóa DATABASE_URL — chống env leak sandbox + URL tương đối;
 * logic mirror src/lib/db.ts — script giữ tự chứa, không import app module)
 * In ra: runs / jobs / messages / reviews mới trong cửa sổ thời gian + trạng thái treo/lỗi
 */
import fs from 'fs'
import path from 'path'

// ---- DATABASE_URL resolution (mirror src/lib/db.ts — Task 55) ----
function findProjectRoot(): string {
  let root = process.cwd()
  for (let i = 0; i < 6 && !fs.existsSync(path.join(root, 'prisma', 'schema.prisma')); i++) {
    root = path.dirname(root)
  }
  return root
}

function readEnvFileDatabaseUrl(envPath: string): string {
  if (!fs.existsSync(envPath)) return ''
  try {
    let value = ''
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/)
      if (m) {
        let v = m[1].trim().replace(/\s+#.*$/, '').trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        value = v
      }
    }
    return value
  } catch {
    return ''
  }
}

;(function resolveDatabaseUrl() {
  const root = findProjectRoot()
  const inherited = (process.env.DATABASE_URL || '').trim()
  const envUrl = readEnvFileDatabaseUrl(path.join(root, '.env'))
  // Lớp 1: env leak guard — env kế thừa trỏ file không tồn tại → ưu tiên .env
  if (envUrl && inherited) {
    const ip = inherited.match(/^file:(.+)$/)?.[1]?.trim()
    if (ip) {
      const abs = path.isAbsolute(ip) ? ip : path.resolve(process.cwd(), ip)
      if (!fs.existsSync(abs)) {
        console.warn(`[DB] ⚠️ DATABASE_URL kế thừa ("${inherited}") trỏ file KHÔNG tồn tại — ưu tiên .env: "${envUrl}"`)
        process.env.DATABASE_URL = envUrl
      }
    }
  } else if (envUrl && !inherited) {
    process.env.DATABASE_URL = envUrl
  }
  // Lớp 2: tương đối → tuyệt đối (schema-relative — cùng ngữ nghĩa Prisma CLI)
  const m = (process.env.DATABASE_URL || '').match(/^file:(.+)$/)
  if (m) {
    const p = m[1].trim()
    const isAbs = p && (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p))
    if (p && !isAbs) {
      process.env.DATABASE_URL = 'file:' + path.resolve(path.join(root, 'prisma'), p)
    }
  }
})()

import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

const args = process.argv.slice(2)
const sinceMinIdx = args.indexOf('--since-min')
const sinceMin = sinceMinIdx >= 0 ? Number(args[sinceMinIdx + 1]) || 60 : 60
const since = new Date(Date.now() - sinceMin * 60_000)
const now = Date.now()

function ago(d: Date | null | undefined) {
  if (!d) return 'never'
  const s = Math.round((now - d.getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

async function main() {
  const [runs, jobs, msgs, reviews] = await Promise.all([
    db.agentRunRecord.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.goalLoopJob.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.chatMessage.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.opusReview.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ])

  console.log(`\n===== WATCH window=${sinceMin}m since=${since.toISOString()} =====`)
  console.log(`new: runs=${runs.length} jobs=${jobs.length} messages=${msgs.length} reviews=${reviews.length}`)

  if (msgs.length) {
    console.log(`\n--- MESSAGES (newest first) ---`)
    for (const m of msgs) console.log(`  [${m.createdAt.toISOString()}] ${String(m.role).padEnd(9)} sess=${m.sessionId.slice(-6)} ${String(m.model || '').padEnd(16)} ${(m.content || '').slice(0, 90).replace(/\n/g, ' ')}`)
  }

  if (runs.length) {
    console.log(`\n--- AGENT RUNS (newest first) ---`)
    for (const r of runs) {
      const st = r.status || '?'
      const flag = st === 'failed' ? ' ⚠️FAILED' : (st === 'running' && r.startedAt && now - r.startedAt.getTime() > 15 * 60_000) ? ' ⚠️STUCK>15m' : ''
      console.log(`  [${r.createdAt.toISOString()}] ${String(r.agentName || r.agentId).padEnd(12)} ${String(st).padEnd(10)} stop=${String(r.stopReason)} cycles=${r.cycles} tokens=${r.tokensUsed} dur=${r.durationMs}ms complete=${r.complete}${flag}`)
    }
  }

  if (jobs.length) {
    console.log(`\n--- GOAL-LOOP JOBS (newest first) ---`)
    for (const j of jobs) {
      const flag = j.status === 'failed' ? ' ⚠️FAILED' : (j.status === 'running' && j.startedAt && now - j.startedAt.getTime() > 15 * 60_000) ? ' ⚠️STUCK>15m' : (j.status === 'queued' && now - j.createdAt.getTime() > 5 * 60_000) ? ' ⚠️QUEUED>5m' : ''
      console.log(`  [${j.createdAt.toISOString()}] ${j.id.slice(-6)} ${String(j.status).padEnd(10)} cycles=${j.cyclesDone} attempts=${j.attempts} hb=${ago(j.heartbeatAt)} err=${(j.error || '').slice(0, 80)}${flag}`)
      console.log(`      input: ${(j.input || '').slice(0, 120).replace(/\n/g, ' ')}`)
    }
  }

  if (reviews.length) {
    console.log(`\n--- OPUS REVIEWS (newest first) ---`)
    for (const r of reviews) console.log(`  [${r.createdAt.toISOString()}] run=${String(r.runRef || '').slice(-18)} ${String(r.decision).padEnd(10)} mode=${String(r.triggerMode || '').padEnd(8)} ${(r.verdict || r.model || '').slice(0, 80).replace(/\n/g, ' ')}`)
  }

  // Tổng thể trạng đang chạy ngay bây giờ (không giới hạn window)
  const activeRuns = await db.agentRunRecord.findMany({ where: { status: 'running' }, take: 20 })
  const activeJobs = await db.goalLoopJob.findMany({ where: { status: { in: ['queued', 'running'] } }, take: 20 })
  console.log(`\n--- ACTIVE NOW: runs=${activeRuns.length} jobs=${activeJobs.length} ---`)
  for (const r of activeRuns) console.log(`  RUN ${String(r.agentName || r.agentId || '?').padEnd(12)} started=${ago(r.startedAt)} runId=${String(r.runId).slice(0, 18)}`)
  for (const j of activeJobs) console.log(`  JOB ${j.id.slice(-6)} ${j.status} hb=${ago(j.heartbeatAt)} input="${(j.input || '').slice(0, 60).replace(/\n/g, ' ')}"`)
}

main().catch(e => { console.error('WATCH ERROR:', e.message); process.exit(1) }).finally(() => db.$disconnect())
