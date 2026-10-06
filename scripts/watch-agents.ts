/**
 * WATCH-AGENTS — Trạm quan sát vận hành agents (Task 54)
 * Chạy: bun scripts/watch-agents.ts [--since-min N]
 * (Task 55: tự chuẩn hóa DATABASE_URL — chống env leak sandbox + URL tương đối;
 * logic mirror src/lib/db.ts — script giữ tự chứa, không import app module)
 *
 * ROUND-52 (user directive 2026-10-07 — "các lượt quan sát trước thiếu mất
 * phần quan sát cả với database"): DATABASE TRỞ THÀNH KÊNH QUAN SÁT HẠNG NGANG
 * với dev.log — quy trình thực thi tác vụ của agents BAO GỒM phần kết nối DB
 * (work ledger P-D, hồi quy P-E, todo lifecycle, chuỗi SELF-DIRECTION của
 * Opus). Không thấy DB là không thấy agents làm việc thật.
 *
 * In ra (cửa sổ --since-min, mặc định 60m):
 *   Kênh vận hành : runs / jobs / messages / reviews / active-now
 *   KÊNH DATABASE :
 *   - WORK LEDGER (AgentWorkData)          — P-D: agents tra cứu/cập nhật/dọn dữ liệu công việc
 *   - REGRESSION  (TaskContextArchive)     — P-E: snapshot việc dở chờ hồi quy / đã giải xong
 *   - TODO LIFECYCLE (Todo)                — kế hoạch việc: mở/đóng/reopen/theo run
 *   - SELF-DIRECTION (Proposal + Steps)    — chuỗi Opus duyệt→triển khai: trạng thái, reviewer,
 *                                            bước đang chạy, biên lai pipeline (commit/push thật?)
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
  if (s < 0) return `in ${Math.abs(Math.round(s / 60))}m`
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/** Preview nội dung 1 dòng, thay newline — an toàn với mọi chuỗi (kể cả rác marker). */
function pv(s: string | null | undefined, n = 90): string {
  if (typeof s !== 'string') return ''
  return s.replace(/\s+/g, ' ').trim().slice(0, n)
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
    for (const m of msgs) console.log(`  [${m.createdAt.toISOString()}] ${String(m.role).padEnd(9)} sess=${m.sessionId.slice(-6)} ${String(m.model || '').padEnd(16)} ${pv(m.content)}`)
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
      console.log(`  [${j.createdAt.toISOString()}] ${j.id.slice(-6)} ${String(j.status).padEnd(10)} cycles=${j.cyclesDone} attempts=${j.attempts} hb=${ago(j.heartbeatAt)} err=${pv(j.error, 80)}${flag}`)
      console.log(`      input: ${pv(j.input, 120)}`)
    }
  }

  if (reviews.length) {
    console.log(`\n--- OPUS REVIEWS (newest first) ---`)
    for (const r of reviews) console.log(`  [${r.createdAt.toISOString()}] run=${String(r.runRef || '').slice(-18)} ${String(r.decision).padEnd(10)} mode=${String(r.triggerMode || '').padEnd(8)} ${pv(r.verdict || r.model, 80)}`)
  }

  // ======================================================================
  // KÊNH QUAN SÁT DATABASE (round-52 — user directive: quan sát BAO GỒM DB)
  // ======================================================================

  // ---- 1. WORK LEDGER (AgentWorkData — P-D) ----
  // Bản ghi dữ liệu công việc agents ghi/đọc/dọn trong cửa sổ. Quan sát thấy:
  // agent có thực sự chạy vòng TRA CỨU → LÀM → CẬP NHẬT → DỌN (completed).
  try {
    const ledgerRecent = await db.agentWorkData.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    })
    const ledgerActive = await db.agentWorkData.groupBy({
      by: ['sessionId'],
      where: { status: 'active' },
      _count: { _all: true },
    })
    const ledgerCompletedWindow = await db.agentWorkData.count({
      where: { status: 'completed', completedAt: { gte: since } },
    })
    console.log(`\n--- 📦 WORK LEDGER (AgentWorkData — P-D) — activity=${ledgerRecent.length} in window | completed(dọn)=${ledgerCompletedWindow} | active theo session=${ledgerActive.length} ---`)
    for (const r of ledgerRecent) {
      console.log(`  [${r.updatedAt.toISOString()}] ${String(r.agentName).padEnd(10)} ${String(r.status).padEnd(9)} ${String(r.kind).padEnd(8)} sess=${r.sessionId.slice(-10)} run=${String(r.runId || '').slice(-8)} ${r.key ? `key=${r.key} ` : ''}${r.content.length}ch: ${pv(r.content, 80)}`)
    }
    for (const g of ledgerActive) {
      console.log(`  ACTIVE sess=${g.sessionId.slice(-10)}: ${g._count._all} bản ghi`)
    }
    if (ledgerRecent.length === 0 && ledgerActive.length === 0) console.log('  (trống — chưa có agent ghi work_data)')
  } catch (err) {
    console.warn(`  [WorkLedger] lỗi đọc (fail-open): ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---- 2. REGRESSION QUEUE (TaskContextArchive kind=regression — P-E) ----
  // Snapshot việc dở: OPEN = còn phần hồi quy chờ run kế; resolved = đã xử
  // lý xong (lưu ý: model KHÔNG có updatedAt — mốc thời gian resolve không
  // truy được, chỉ hiện tổng số resolved; tuổi của snapshot OPEN tính theo
  // createdAt — snapshot resolve xong mới thôi).
  try {
    const snapsOpen = await db.taskContextArchive.findMany({
      where: { kind: 'regression', tags: 'open' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    const snapsResolvedTotal = await db.taskContextArchive.count({
      where: { kind: 'regression', tags: 'resolved' },
    })
    console.log(`\n--- 🔄 REGRESSION QUEUE (việc dở chờ hồi quy — P-E) — OPEN=${snapsOpen.length} | resolved(tổng)=${snapsResolvedTotal} ---`)
    for (const s of snapsOpen) {
      let n = 0
      let stop = ''
      try {
        const parsed = JSON.parse(s.content) as { todos?: unknown[]; stopReason?: string | null }
        n = Array.isArray(parsed.todos) ? parsed.todos.length : 0
        stop = String(parsed.stopReason ?? '')
      } catch { /* content hỏng — vẫn hiện dòng với n=0 */ }
      console.log(`  [${s.createdAt.toISOString()}] sess=${String(s.sessionId || '').slice(-10)} run=${String(s.runId || '').slice(-8)} ${n} việc dở | dừng=${stop || '?'} | tạo ${ago(s.createdAt)}${now - s.createdAt.getTime() > 24 * 3600_000 ? ' ⚠️>24h chưa ai hồi quy hết' : ''}`)
    }
    if (snapsOpen.length === 0) console.log('  (không có việc dở chờ hồi quy)')
  } catch (err) {
    console.warn(`  [Regression] lỗi đọc (fail-open): ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---- 3. TODO LIFECYCLE (Todo) ----
  // Kế hoạch việc của agents: tạo mới / cập nhật trong cửa sổ + tình trạng mở
  // hiện tại (in_progress/blocked kẹt lâu = tín hiệu stall). Session delegation:*
  // là todo sub-agent (scope riêng r50) — hiện đúng attribution.
  try {
    const todosWindow = await db.todo.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    })
    const byStatus = new Map<string, number>()
    for (const t of todosWindow) byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1)
    const openNow = await db.todo.findMany({
      where: { status: { in: ['in_progress', 'blocked'] }, archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 15,
    })
    console.log(`\n--- 📋 TODO LIFECYCLE — activity=${todosWindow.length} in window (${[...byStatus.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || '-'}) | đang mở(in_progress/blocked)=${openNow.length} ---`)
    for (const t of todosWindow) {
      console.log(`  [${t.updatedAt.toISOString()}] ${String(t.status).padEnd(11)} sess=${t.sessionId.slice(-14).padEnd(14)} run=${String(t.runId || '').slice(-8)} [id ${t.id.slice(-6)}] ${pv(t.content, 90)}`)
    }
    for (const t of openNow) {
      const stuck = now - t.updatedAt.getTime() > 30 * 60_000 ? ' ⚠️>30m không tín hiệu' : ''
      console.log(`  OPEN ${String(t.status).padEnd(11)} sess=${t.sessionId.slice(-14).padEnd(14)} run=${String(t.runId || '').slice(-8)} cập nhật ${ago(t.updatedAt)}${stuck} [id ${t.id.slice(-6)}] ${pv(t.content, 80)}`)
    }
    if (todosWindow.length === 0) console.log('  (không có todo nào được tạo/cập nhật trong cửa sổ)')
  } catch (err) {
    console.warn(`  [Todo] lỗi đọc (fail-open): ${err instanceof Error ? err.message : String(err)}`)
  }

  // ---- 4. SELF-DIRECTION CHAIN (Opus duyệt → triển khai liên hoàn) ----
  // Trạng thái chuỗi: proposals theo status; bước đang chạy; biên lai pipeline
  // gần nhất (dryRun?/commit/push) — thấy ngay deploy THẬT hay dry-run.
  try {
    const proposals = await db.selfDirectionProposal.findMany({
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 15,
    })
    const statusOrder = ['pending', 'approved', 'ready', 'planning', 'executing', 'completed', 'failed', 'rejected']
    proposals.sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) || b.updatedAt.getTime() - a.updatedAt.getTime())
    console.log(`\n--- 🚀 SELF-DIRECTION CHAIN (Opus ủy quyền duyệt → triển khai liên hoàn) ---`)
    for (const p of proposals) {
      const active = ['ready', 'planning', 'executing'].includes(p.status)
      console.log(`  ${p.id.slice(-6)} ${String(p.status).padEnd(10)} ${active ? '▶' : ' '} rev=${String(p.reviewer || '-').padEnd(13)} mode=${String(p.executionMode).padEnd(13)} prio=${String(p.priority).padEnd(8)} upd=${ago(p.updatedAt)} ${active ? '⚠️ĐANG CHẠY — chuỗi chờ' : ''}`)
      console.log(`      ${pv(p.title, 100)}`)
    }
    // Bước đang chạy của orchestration active
    const activeProps = proposals.filter(p => ['planning', 'executing'].includes(p.status))
    if (activeProps.length > 0) {
      const steps = await db.proposalStep.findMany({
        where: { proposalId: { in: activeProps.map(p => p.id) }, status: 'in_progress' },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      })
      console.log(`  ── bước đang chạy: ${steps.length} ──`)
      for (const s of steps) {
        console.log(`    [${s.updatedAt.toISOString()}] ${s.proposalId.slice(-6)}#${s.stepOrder} ${String(s.assignee).padEnd(10)} lần thử=${s.attempts} ${ago(s.updatedAt)}: ${pv(s.title, 80)}`)
      }
    }
    // Biên lai pipeline gần nhất (bước có workspaceReceipt trong cửa sổ)
    // (filter `not: null` trên Json nullable không typecheck được với Prisma
    // client — lấy theo updatedAt rồi lọc JS: số bước trong cửa sổ luôn ít)
    const receiptStepsAll = await db.proposalStep.findMany({
      where: { updatedAt: { gte: since } },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    })
    const receiptSteps = receiptStepsAll.filter(s => s.workspaceReceipt != null).slice(0, 5)
    if (receiptSteps.length > 0) {
      console.log(`  ── biên lai pipeline trong cửa sổ: ${receiptSteps.length} ──`)
      for (const s of receiptSteps) {
        const r = s.workspaceReceipt as Record<string, unknown> | null
        const dry = r?.dryRun === true ? 'DRY-RUN' : 'THẬT'
        const commit = typeof r?.commitHash === 'string' ? r.commitHash.slice(0, 9) : '-'
        const pushed = r?.pushed === true ? 'pushed' : 'chưa push'
        console.log(`    [${s.updatedAt.toISOString()}] ${s.proposalId.slice(-6)}#${s.stepOrder} pipeline=${r?.success === true ? 'PASS' : 'FAIL'} (${dry}, commit=${commit}, ${pushed})`)
      }
    }
    if (proposals.length === 0) console.log('  (không có đề xuất nào)')
  } catch (err) {
    console.warn(`  [SelfDirection] lỗi đọc (fail-open): ${err instanceof Error ? err.message : String(err)}`)
  }

  // Tổng thể trạng đang chạy ngay bây giờ (không giới hạn window)
  const activeRuns = await db.agentRunRecord.findMany({ where: { status: 'running' }, take: 20 })
  const activeJobs = await db.goalLoopJob.findMany({ where: { status: { in: ['queued', 'running'] } }, take: 20 })
  console.log(`\n--- ACTIVE NOW: runs=${activeRuns.length} jobs=${activeJobs.length} ---`)
  for (const r of activeRuns) console.log(`  RUN ${String(r.agentName || r.agentId || '?').padEnd(12)} started=${ago(r.startedAt)} runId=${String(r.runId).slice(0, 18)}`)
  for (const j of activeJobs) console.log(`  JOB ${j.id.slice(-6)} ${j.status} hb=${ago(j.heartbeatAt)} input="${pv(j.input, 60)}"`)
}

main().catch(e => { console.error('WATCH ERROR:', e.message); process.exit(1) }).finally(() => db.$disconnect())
