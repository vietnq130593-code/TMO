#!/usr/bin/env bun
/**
 * mission-watch.ts — Công cụ quan sát mission TMO (round-56: KÊNH FINAL REPORTS)
 *
 * Bối cảnh: round-54 phát hiện blind spot — quan sát trước đó chỉ thấy tool events
 * (agents LÀM GÌ) mà không thấy suy nghĩ/nội dung assistant (agents NGHĨ GÌ), khiến
 * (a) tool-call Anthropic-style nằm trong thought content (bug pattern-5) vô hình,
 * (b) vòng lặp todo_read ×123 của sub-agent SENTINEL chỉ thấy triệu chứng muộn.
 *
 * BỔ SUNG r55w1 (FIX G): sub-agent delegation GIỜ CÓ thought events (recordAgentThought
 * nhận runId) — jsonl sub_*.jsonl hiển thị cả 💭 suy nghĩ của sub-agent, không chỉ 🔧 tool.
 *
 * BỔ SUNG r56 (FIX H — kênh FINAL REPORTS): thấy "đang làm gì/nghĩ gì" mà không thấy
 * KẾT LUẬN vẫn là mù (bằng chứng SENTINEL: sub-agent chốt "trọng tài CHƯA ĐẠT (10%)"
 * chỉ nằm trong run_end 300 chars; verdict Opus "không đọc được verdict JSON từ model"
 * không kênh nào bắt; GoalLoopJob.result 9k chars không bao giờ hiển thị). Giờ:
 *   - LIVE: job chuyển terminal → emit 📋 FINAL REPORT (content + taskSummary +
 *     detector cú pháp tool-call chạy trên chính báo cáo cuối); poll OpusReview →
 *     ⚖️ OPUS VERDICT (5 trục + issues + directive + STOP predicate 4/4)
 *   - SNAPSHOT: taskSummary của mission gần nhất + 2 verdict Opus gần nhất
 *   - REPLAY: section BÁO CÁO CUỐI + OPUS VERDICT của session; run_end đủ 300 chars
 *
 * Nguồn dữ liệu (đã kiểm chứng 2026-10-07):
 *   - GoalLoopJob (SQLite): status/heartbeat/cycles + checkpoint JSON
 *       → checkpoint.messages = transcript (assistant content THÔ chứa cả
 *         tool-call chưa parse + thinking inline của model)
 *       → checkpoint.counters = token burn live (kể cả subagentTokens)
 *   - agent-runs/<runId>.jsonl: event stream
 *       type = run_start | thought | tool | todo_update | run_end
 *
 * Chế độ (giao thức vận hành: xem GIAO_THUC_GIAM_SAT_AGENTS.md mục 1b):
 *   bun scripts/mission-watch.ts                    # SNAPSHOT: tình trạng mission hiện tại
 *   bun scripts/mission-watch.ts --follow           # LIVE: theo dõi realtime (Ctrl+C thoát)
 *   bun scripts/mission-watch.ts --replay <jobId|runId|file> [--tail 50]
 *                                                    # HẬU KIỂM: timeline mission đã kết thúc
 *
 * Không sửa code TMO, không cần DATABASE_URL (mở SQLite read-only trực tiếp).
 * Chạy được từ bất kỳ đâu trong repo (đường dẫn suy từ vị trí file này).
 */
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'

// repo root = thư mục cha của scripts/ (di động — không hardcode máy cụ thể)
const TMO_DIR = path.resolve(import.meta.dir, '..')
const DB_PATH = path.join(TMO_DIR, 'db', 'custom.db')
const RUNS_DIR = path.join(TMO_DIR, 'agent-runs')

// ─────────────────────────── helpers ───────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function trunc(s: string | null | undefined, n: number): string {
  if (!s) return ''
  s = String(s).replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

function hhmmss(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19) + 'Z'
}

function now(): string {
  return hhmmss(Date.now())
}

function shortId(id: string | null | undefined): string {
  if (!id) return '?'
  // giữ đuôi discriminant: cmuxrs505000ill1d3qch0jj4 → …ch0jj4
  return '…' + id.slice(-6)
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function fmtTokens(n: number | undefined | null): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function parseMaybeJson(s: string | null | undefined): any {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// ─────────────────────────── DB ───────────────────────────

function openDb(): Database {
  try {
    return new Database(DB_PATH, { readonly: true })
  } catch {
    return new Database(DB_PATH)
  }
}

interface JobRow {
  id: string
  sessionId: string
  status: string
  cyclesDone: number
  heartbeatAt: string | null
  updatedAt: string
  checkpoint: string | null
  stopReason: string | null
  input: string
  /** FIX H r56 — JSON GoalLoopResult khi completed (content final + taskSummary) */
  result: string | null
  /** FIX H r56 — lỗi crash khi failed */
  error: string | null
}

function getJobs(db: Database, onlyActive: boolean): JobRow[] {
  const where = onlyActive ? "WHERE status IN ('queued','running')" : ''
  const rows = db
    .query(
      `SELECT id, sessionId, status, cyclesDone, heartbeatAt, updatedAt, checkpoint, stopReason, input, result, error
       FROM GoalLoopJob ${where} ORDER BY updatedAt DESC LIMIT 12`,
    )
    .all() as any[] as JobRow[]
  return rows
}

/** Trích agentName từ job.input JSON (nhiều khả năng key, fail-open). */
function agentNameOf(job: JobRow): string {
  const inp = parseMaybeJson(job.input)
  if (!inp) return '?'
  return inp.agentName || inp.agent?.name || inp.agent || inp.agentId || '?'
}

// ─────────────────────── final reports (FIX H r56 — kênh thứ 5) ───────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])

interface FinalReport {
  content: string
  taskSummary?: string
  iterations?: number
}

/** Bóc báo cáo cuối từ GoalLoopJob.result (JSON GoalLoopResult); failed → error. */
function finalReportOf(job: JobRow): FinalReport | null {
  if (job.result) {
    const r = parseMaybeJson(job.result)
    if (r && typeof r.content === 'string') {
      return { content: r.content, taskSummary: r.taskSummary ?? undefined, iterations: r.iterations }
    }
    return { content: job.result } // result không đúng shape GoalLoopResult — dùng thô
  }
  if (job.error) return { content: `ERROR: ${job.error}` }
  return null
}

/** Emit khi job chuyển terminal ở LIVE: báo cáo cuối + detector cú pháp tool-call. */
function finalReportLines(job: JobRow, maxContent = 1000): string[] {
  const out: string[] = []
  const fin = finalReportOf(job)
  out.push(
    `${now()} 📋 FINAL REPORT [${agentNameOf(job)} · job${shortId(job.id)}] — ${job.status}${job.stopReason ? ' · stop=' + job.stopReason : ''}`,
  )
  if (!fin) {
    out.push(`${now()}    (không có result/error — job bị dừng trước khi finalize, vd cancel)`)
    return out
  }
  if (fin.taskSummary) out.push(`${now()}    📌 ${trunc(fin.taskSummary, 300)}`)
  out.push(`${now()}    📄 ${trunc(fin.content, maxContent)}`)
  for (const w of scanToolSyntax(fin.content)) out.push(`${now()}    ⚠️ ${w}`)
  return out
}

/** 5 trục OpusVerdict → "specCompliance: 5/10 · processQuality: 4/10 · …". */
function fmtAxes(axes: any): string {
  if (!axes || typeof axes !== 'object') return ''
  return Object.entries(axes)
    .map(([k, v]: [string, any]) => `${k}: ${v && typeof v === 'object' && typeof v.score === 'number' ? v.score : '?'}/10`)
    .join(' · ')
}

/** 1 OpusReview row → các dòng hiển thị. lines[0] = header, phần còn lại = body. */
function verdictLines(
  r: { decision: string; triggerMode?: string | null; verdict?: string | null },
  verbose: boolean,
): string[] {
  const v = parseMaybeJson(r.verdict)
  const out = [`⚖️ [${r.decision}${r.triggerMode ? '/' + r.triggerMode : ''}]`]
  if (v?.summary) out.push(`   📝 ${trunc(String(v.summary), verbose ? 400 : 180)}`)
  const axes = fmtAxes(v?.axes)
  if (axes) out.push(`   📊 ${axes}`)
  if (Array.isArray(v?.issues) && v.issues.length) {
    out.push(`   ⚠️ ${v.issues.length} issue: ${v.issues.map((i: any) => `[${i?.severity ?? '?'}] ${trunc(String(i?.title ?? ''), 70)}`).join(' | ')}`)
  }
  if (v?.directive?.goal) out.push(`   📌 directive: ${trunc(String(v.directive.goal), verbose ? 300 : 160)}`)
  if (verbose && Array.isArray(v?.directive?.acceptanceCriteria) && v.directive.acceptanceCriteria.length) {
    out.push(`   ✅ nghiệm thu: ${v.directive.acceptanceCriteria.map((c: any) => trunc(String(c), 90)).join(' / ')}`)
  }
  if (verbose && v?.stopAssessment) {
    const s = v.stopAssessment
    out.push(
      `   🛑 STOP predicate: ledger ${s.ledgerClean ? '✓' : '✗'} · verify ${s.verificationGreen ? '✓' : '✗'} · spec ${s.specSatisfied ? '✓' : '✗'} · noNewBlocking ${s.noNewBlocking ? '✓' : '✗'}${s.allMet ? ' → ĐỦ 4/4' : ''}`,
    )
  }
  return out
}

// ─────────────────────────── jsonl tailing ───────────────────────────

class Tail {
  offset = 0
  partial = ''
  constructor(public file: string, skipToCurrentEnd: boolean) {
    try {
      if (skipToCurrentEnd) this.offset = fs.statSync(file).size
    } catch {
      /* file chưa tồn tại — offset 0, sẽ bắt đầu khi file xuất hiện */
    }
  }
  /** Đọc phần mới; trả về [] nếu không có gì. File biến mất → reset. */
  read(): any[] {
    let st: fs.Stats
    try {
      st = fs.statSync(this.file)
    } catch {
      return []
    }
    if (st.size < this.offset) {
      // file bị xoay/thu nhỏ → đọc lại từ đầu
      this.offset = 0
      this.partial = ''
    }
    if (st.size === this.offset) return []
    const fd = fs.openSync(this.file, 'r')
    try {
      const buf = Buffer.alloc(st.size - this.offset)
      fs.readSync(fd, buf, 0, buf.length, this.offset)
      this.offset = st.size
      this.partial += buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
    const lines = this.partial.split('\n')
    this.partial = lines.pop() ?? ''
    const events: any[] = []
    for (const l of lines) {
      const t = l.trim()
      if (!t) continue
      try {
        events.push(JSON.parse(t))
      } catch {
        /* dòng dở/hoại — bỏ qua */
      }
    }
    return events
  }
}

function readAllEvents(file: string): any[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

// ─────────────────────────── formatting events ───────────────────────────

function fmtEvent(e: any): string {
  const t = e.ts ? hhmmss(e.ts) : now()
  const who = e.agentName || e.runId || '?'
  switch (e.type) {
    case 'thought':
      return `${t} 💭 [${who} ·v${e.iteration ?? '?'}] ${trunc(e.text, 240)}`
    case 'tool':
      return `${t} 🔧 [${who}] ${e.tool}${e.argsSummary ? '(' + trunc(String(e.argsSummary), 90) + ')' : ''} ${e.success ? '✓' : '✗'} ${e.durationMs ?? '?'}ms → ${trunc(e.resultPreview, 130)}`
    case 'todo_update': {
      const todos: any[] = e.todos || []
      const done = todos.filter((x) => x.status === 'completed').length
      const marks = todos.map((x) => (x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '◐' : '○')).join('')
      return `${t} 📋 [${who}] todos ${done}/${todos.length} ${marks}`
    }
    case 'run_start':
      return `${t} 🚀 [${who}] RUN START ${trunc(e.text || e.label || e.title || JSON.stringify({ runId: e.runId, sessionId: e.sessionId }), 140)}`
    case 'run_end':
      // FIX H r56: hiển thị đủ 300 chars đã ghi — dòng "trọng tài CHƯA ĐẠT (10%)"
      // kiểu SENTINEL phải hiện nguyên vẹn, không cắt mất phán quyết
      return `${t} 🏁 [${who}] ${trunc(e.text || JSON.stringify({ success: e.success }), 300)}`
    default:
      return `${t} ❓ [${who}] ${e.type} ${trunc(JSON.stringify(e), 140)}`
  }
}

// ─────────────────────────── phân tích ───────────────────────────

/** Bộ đếm lặp cùng-dấu-vết — phát hiện stall-loop kiểu todo_read ×72. */
class RepeatTracker {
  private state = new Map<string, { key: string; count: number; warned: number }>()
  /** trả về warning nếu cần báo, khác null */
  check(e: any): string | null {
    if (e.type !== 'tool') return null
    const rid = e.runId || 'unknown'
    const key = `${e.tool}|${e.argsSummary}|${e.resultPreview}`
    const cur = this.state.get(rid)
    if (cur && cur.key === key) {
      cur.count++
      if (cur.count >= 5 && cur.count > cur.warned + 4) {
        cur.warned = cur.count
        return `🔁 [${e.agentName || rid}] '${e.tool}' lặp ${cur.count} lần LIÊN TIẾP cùng args + cùng kết quả — dấu hiệu stall-loop (nên can thiệp)`
      }
    } else {
      this.state.set(rid, { key, count: 1, warned: 0 })
    }
    return null
  }
  /** Top nhóm lặp cho replay/hậu kiểm. */
  static topGroups(events: any[], min = 5): string[] {
    const groups = new Map<string, { tool: string; args: string; res: string; count: number }>()
    for (const e of events) {
      if (e.type !== 'tool') continue
      const k = `${e.tool}|${e.argsSummary}|${e.resultPreview}`
      const g = groups.get(k) || { tool: e.tool, args: String(e.argsSummary || ''), res: String(e.resultPreview || ''), count: 0 }
      g.count++
      groups.set(k, g)
    }
    return [...groups.values()]
      .filter((g) => g.count >= min)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((g) => `🔁 '${g.tool}' ×${g.count} — args: ${trunc(g.args, 80)} → kết quả giống hệt: ${trunc(g.res, 80)}`)
  }
}

/** Detector cú pháp tool-call nằm lọt trong text (bug pattern-5 round-54). */
const TOOL_SYNTAX_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'pattern-5 Anthropic `invoke <tool_name>`', re: /invoke\s*<tool_name>/i },
  { label: 'khối `<parameters>`', re: /<parameters>[\s\S]{0,300}?<\/parameters>/i },
  { label: 'Mistral `<invoke name=` / `invoke name="`', re: /<invoke\s+name=|invoke\s+name\s*=\s*"/i },
  { label: 'JSON function-call `{"name":…,"arguments":…}`', re: /\{\s*"name"\s*:\s*"[a-z0-9_]+"[\s\S]{0,80}?"arguments"\s*:/i },
]

function scanToolSyntax(content: string): string[] {
  const out: string[] = []
  if (!content) return out
  for (const p of TOOL_SYNTAX_PATTERNS) {
    const m = content.match(p.re)
    if (m) {
      const idx = m.index ?? 0
      out.push(`Nghi tool-call CHƯA ĐƯỢC PARSE (${p.label}) — trích: "${trunc(content.slice(Math.max(0, idx - 40), idx + 160), 200)}"`)
    }
  }
  return out
}

/** Trạng thái checkpoint mỗi job — phát hiện assistant content mới/khác. */
const ckptSeen = new Map<string, { sig: string; lastAsst: string }>()

function watchCheckpoint(job: JobRow): string[] {
  const out: string[] = []
  const ck = parseMaybeJson(job.checkpoint)
  if (!ck) return out
  const msgs: any[] = ck.messages || []
  const c = ck.counters || {}
  const sig = msgs.map((m) => `${m.role}:${m.content.length}`).join('|') + `#${c.cyclesDone ?? 0}`
  const prev = ckptSeen.get(job.id)
  ckptSeen.set(job.id, { sig, lastAsst: '' })
  if (prev && prev.sig === sig) return out

  const name = agentNameOf(job)
  out.push(
    `${now()} 📊 [${name} · job${shortId(job.id)}] chu kỳ ${c.cyclesDone ?? '?'} · vòng ${c.totalIterations ?? '?'} · tools ${c.totalToolCalls ?? '?'} · tokens ${fmtTokens(c.tokensUsed)} (sub-agent: ${fmtTokens(c.subagentTokens)}) · nén context ×${c.compressions ?? 0} · stall ${c.stallCycles ?? 0}/${(c as any).noProgressCount ?? 0}`,
  )
  const asst = msgs.filter((m) => m.role === 'assistant')
  const last = asst[asst.length - 1]
  if (last && (!prev || prev.lastAsst !== last.content)) {
    out.push(`${now()} 🤖 [${name}] ASSISTANT (${last.content.length} chars): ${trunc(last.content, 600)}`)
    for (const w of scanToolSyntax(last.content)) out.push(`${now()} ⚠️ 🤖 ${w}`)
  }
  if (ck.lastLlmError) out.push(`${now()} ⚠️ [${name}] lastLlmError: ${trunc(ck.lastLlmError, 200)}`)
  return out
}

// ─────────────────────────── SNAPSHOT ───────────────────────────

function snapshot(): void {
  const db = openDb()
  const active = getJobs(db, true)
  const recent = getJobs(db, false).slice(0, 6)
  console.log(`╔══ MISSION SNAPSHOT · ${new Date().toISOString()}`)
  if (active.length === 0) {
    console.log('║ ⚪ Không có mission nào đang chạy (queued/running = 0)')
  }
  for (const j of active) {
    const name = agentNameOf(j)
    const hbAge = j.heartbeatAt ? Date.now() - new Date(j.heartbeatAt).getTime() : null
    const ck = parseMaybeJson(j.checkpoint)
    const c = ck?.counters || {}
    console.log(`║`)
    console.log(`║ 🟢 ĐANG CHẠY: [${name}] job${shortId(j.id)} · session ${j.sessionId}`)
    console.log(`║    status=${j.status} · chu kỳ ${j.cyclesDone} · heartbeat ${hbAge == null ? '?' : fmtMs(hbAge) + ' trước'}${hbAge != null && hbAge > 120_000 ? ' ⚠️ STALE' : ''}`)
    if (ck) {
      console.log(`║    tokens ${fmtTokens(c.tokensUsed)} (sub ${fmtTokens(c.subagentTokens)}) · tools ${c.totalToolCalls} · nén ×${c.compressions ?? 0} · stall ${c.stallCycles ?? 0}`)
      if (ck.runId) {
        const f = path.join(RUNS_DIR, ck.runId + '.jsonl')
        const evs = readAllEvents(f)
        const thoughts = evs.filter((e) => e.type === 'thought')
        const tools = evs.filter((e) => e.type === 'tool')
        console.log(`║    run ${ck.runId}: ${evs.length} events (${thoughts.length} thought / ${tools.length} tool)`)
        for (const th of thoughts.slice(-3)) console.log(`║    💭 ${hhmmss(th.ts)} ${trunc(th.text, 160)}`)
        for (const tl of tools.slice(-3)) console.log(`║    🔧 ${hhmmss(tl.ts)} ${tl.tool}(${trunc(String(tl.argsSummary), 60)}) ${tl.success ? '✓' : '✗'} → ${trunc(tl.resultPreview, 90)}`)
      }
    } else {
      console.log(`║    (chưa có checkpoint — job mới vào hàng đợi)`)
    }
  }
  console.log(`║`)
  console.log(`║ 📜 MISSION GẦN NHẤT:`)
  for (const j of recent) {
    const ck = parseMaybeJson(j.checkpoint)
    const c = ck?.counters || {}
    console.log(
      `║    [${j.status.padEnd(9)}] ${new Date(j.updatedAt).toISOString().slice(5, 16)} [${agentNameOf(j)}] ${fmtTokens(c.tokensUsed)} tokens · ${c.totalToolCalls ?? j.cyclesDone} tools · stop=${j.stopReason ?? '-'}`,
    )
    // FIX H r56: taskSummary = kết luận 1 dòng của báo cáo cuối
    const fin = finalReportOf(j)
    if (fin?.taskSummary) console.log(`║       📋 ${trunc(fin.taskSummary, 160)}`)
  }
  // FIX H r56: 2 verdict Opus gần nhất — phán quyết không còn mù với operator
  try {
    const revs = db
      .query(`SELECT decision, triggerMode, verdict, createdAt FROM OpusReview ORDER BY createdAt DESC LIMIT 2`)
      .all() as any[]
    if (revs.length) {
      console.log(`║`)
      console.log(`║ ⚖️ OPUS VERDICT GẦN NHẤT:`)
      for (const r of revs) {
        const v = parseMaybeJson(r.verdict)
        const summary = v?.summary ? trunc(String(v.summary), 140) : trunc(String(r.verdict ?? ''), 140)
        console.log(`║    [${r.decision}/${r.triggerMode}] ${new Date(r.createdAt).toISOString().slice(5, 16)} 📝 ${summary}`)
      }
    }
  } catch { /* bảng chưa tồn tại — bỏ qua */ }
  console.log('╚══')
  db.close()
}

// ─────────────────────────── FOLLOW (live) ───────────────────────────

async function follow(): Promise<void> {
  const db = openDb()
  const tails = new Map<string, Tail>()
  const repeat = new RepeatTracker()
  const jobSeen = new Map<string, string>() // jobId → last status
  const activeSessions = new Set<string>()
  const knownRunFiles = new Set<string>()
  // FIX H r56 — kênh FINAL REPORTS
  const sessionNames = new Map<string, string>() // sessionId → agentName (giữ cả sau khi job kết thúc)
  const watchedJobIds = new Set<string>() // job từng thấy queued/running trong phiên watch này
  const finalEmitted = new Set<string>() // jobId đã emit FINAL REPORT
  const revSeen = new Set<string>() // OpusReview.id đã xử lý (khởi tạo = toàn bộ row hiện có)
  let revSeenInit = false

  const ensureTail = (file: string) => {
    if (!tails.has(file)) {
      tails.set(file, new Tail(file, false)) // follow → đọc từ đầu file run đang sống (rẻ, vài trăm dòng)
      knownRunFiles.add(file)
    }
  }

  console.log(`${now()} 👁 MISSION-WATCH LIVE — poll 1.5s (Ctrl+C để dừng)`)

  for (;;) {
    let anyOutput = false
    const emit = (line: string) => {
      anyOutput = true
      console.log(line)
    }

    // 1) DB: mission mới / đổi trạng thái / checkpoint mới
    let jobs: JobRow[] = []
    try {
      jobs = getJobs(db, true)
    } catch (e) {
      emit(`${now()} ⚠️ DB read lỗi: ${trunc(String(e), 120)} — thử lại sau`)
    }
    for (const j of jobs) {
      activeSessions.add(j.sessionId)
      sessionNames.set(j.sessionId, agentNameOf(j))
      watchedJobIds.add(j.id)
      const prevStatus = jobSeen.get(j.id)
      if (prevStatus !== j.status) {
        jobSeen.set(j.id, j.status)
        if (prevStatus === undefined) {
          emit(`${now()} 🆕 MISSION BẮT ĐẦU: [${agentNameOf(j)}] job${shortId(j.id)} status=${j.status} · session ${j.sessionId}`)
        } else {
          emit(`${now()} 🔄 [${agentNameOf(j)}] job${shortId(j.id)} status: ${prevStatus} → ${j.status}`)
        }
      }
      const ck = parseMaybeJson(j.checkpoint)
      if (ck?.runId) ensureTail(path.join(RUNS_DIR, ck.runId + '.jsonl'))
      for (const line of watchCheckpoint(j)) emit(line)
      const hbAge = j.heartbeatAt ? Date.now() - new Date(j.heartbeatAt).getTime() : null
      if (hbAge != null && hbAge > 180_000 && j.status === 'running') {
        emit(`${now()} ⚠️ [${agentNameOf(j)}] heartbeat stale ${fmtMs(hbAge)} — job treo/kẹt?`)
      }
    }

    // 1b) FIX H r56: job vừa chuyển terminal (rời active query ngay khi hoàn thành)
    //     → emit FINAL REPORT từ result/error
    try {
      for (const j of getJobs(db, false)) {
        sessionNames.set(j.sessionId, agentNameOf(j))
        if (!TERMINAL_STATUSES.has(j.status)) continue
        if (finalEmitted.has(j.id) || !watchedJobIds.has(j.id)) continue
        finalEmitted.add(j.id)
        emit(`${now()} 🔄 [${agentNameOf(j)}] job${shortId(j.id)} kết thúc: → ${j.status} · stop=${j.stopReason ?? '-'}`)
        for (const l of finalReportLines(j)) emit(l)
      }
    } catch { /* fail-open */ }

    // 1c) FIX H r56: poll OpusReview — verdict mới của Opus (mọi session, mọi chế độ)
    try {
      const rows = db
        .query(`SELECT id, sessionId, decision, triggerMode, verdict, createdAt FROM OpusReview ORDER BY createdAt DESC LIMIT 5`)
        .all() as any[]
      if (!revSeenInit) {
        for (const r of rows) revSeen.add(r.id)
        revSeenInit = true
      } else {
        for (const r of rows.slice().reverse()) {
          if (revSeen.has(r.id)) continue
          revSeen.add(r.id)
          const who = sessionNames.get(r.sessionId) ?? '…' + r.sessionId.slice(-6)
          emit(`${now()} ⚖️ OPUS VERDICT cho [${who}] · ${hhmmss(new Date(r.createdAt).getTime())}`)
          for (const l of verdictLines(r, true).slice(1)) emit(`${now()} ${l}`)
        }
      }
    } catch { /* fail-open */ }

    // 2) khám phá file jsonl mới (sub-agent delegation bỗng xuất hiện)
    try {
      for (const f of fs.readdirSync(RUNS_DIR)) {
        if (!f.endsWith('.jsonl') || knownRunFiles.has(f)) continue
        const full = path.join(RUNS_DIR, f)
        const st = fs.statSync(full)
        // chỉ quan tâm file đang được ghi gần đây
        if (Date.now() - st.mtimeMs > 60_000) continue
        // file phải thuộc session đang active (đọc dòng đầu)
        const first = readAllEvents(full)[0]
        if (!first) continue
        if (activeSessions.size > 0 && first.sessionId && !activeSessions.has(first.sessionId)) continue
        if (f.startsWith('sub_')) emit(`${now()} 🚀 SUB-AGENT delegation khởi động: ${f} [${first.agentName || '?'}]`)
        ensureTail(full)
      }
    } catch {
      /* dir tạm thời không đọc được — bỏ qua */
    }

    // 3) đọc event mới từ mọi file đang theo dõi
    for (const [file, tail] of tails) {
      for (const e of tail.read()) {
        emit(fmtEvent(e))
        const w = repeat.check(e)
        if (w) emit(`${now()} ${w}`)
      }
    }

    if (!anyOutput) process.stdout.write('.')
    await sleep(1500)
  }
}

// ─────────────────────────── REPLAY (hậu kiểm) ───────────────────────────

function replay(target: string, tailN: number): void {
  const db = openDb()
  let mainFile: string | null = null
  let job: JobRow | null = null
  let sessionId: string | null = null

  // resolve target: file trực tiếp / runId / jobId
  const direct = path.join(RUNS_DIR, target.endsWith('.jsonl') ? target : target + '.jsonl')
  if (fs.existsSync(direct)) {
    mainFile = direct
    const first = readAllEvents(direct)[0]
    sessionId = first?.sessionId ?? null
    // tìm job theo sessionId + runId trong checkpoint
    for (const j of getJobs(db, false)) {
      const ck = parseMaybeJson(j.checkpoint)
      if (ck?.runId && path.join(RUNS_DIR, ck.runId + '.jsonl') === direct) {
        job = j
        break
      }
    }
  } else {
    for (const j of getJobs(db, false).concat()) {
      const ck = parseMaybeJson(j.checkpoint)
      if (j.id === target || ck?.runId === target) {
        job = j
        sessionId = j.sessionId
        mainFile = ck?.runId ? path.join(RUNS_DIR, ck.runId + '.jsonl') : null
        break
      }
    }
  }
  if (!mainFile && !job) {
    console.error(`Không tìm thấy '${target}' — thử jobId (cmux…), runId (run_…), hoặc tên file (sub_…).`)
    process.exit(1)
  }

  // gom events: run chính + mọi sub file cùng session
  const files: string[] = []
  if (mainFile) files.push(mainFile)
  if (sessionId) {
    for (const f of fs.readdirSync(RUNS_DIR)) {
      if (!f.startsWith('sub_') || !f.endsWith('.jsonl')) continue
      const full = path.join(RUNS_DIR, f)
      const evs = readAllEvents(full)
      if (evs.length && evs[0].sessionId === sessionId) files.push(full)
    }
  }
  const all: any[] = []
  for (const f of files) all.push(...readAllEvents(f))
  all.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))

  console.log('╔══ MISSION REPLAY')
  if (job) {
    const ck = parseMaybeJson(job.checkpoint)
    const c = ck?.counters || {}
    console.log(`║ job${shortId(job.id)} · [${agentNameOf(job)}] · ${job.status} · stop=${job.stopReason}`)
    console.log(`║ chu kỳ ${c.cyclesDone ?? job.cyclesDone} · vòng ${c.totalIterations ?? '?'} · tools ${c.totalToolCalls ?? '?'} · tokens ${fmtTokens(c.tokensUsed)} (sub ${fmtTokens(c.subagentTokens)}) · nén ×${c.compressions ?? 0}`)
    console.log(`║ files: ${files.map((f) => path.basename(f)).join(' + ') || '(không có)'} · ${all.length} events`)
  } else {
    console.log(`║ target: ${path.basename(mainFile!)} · ${all.length} events`)
  }
  console.log('╚══')
  console.log('')

  // FIX H r56: BÁO CÁO CUỐI (GoalLoopJob.result) — bản finalize chính thức của mission
  if (job) {
    const fin = finalReportOf(job)
    console.log('── BÁO CÁO CUỐI (GoalLoopJob.result) ──')
    if (fin) {
      console.log(`📄 content (${fin.content.length} chars): ${trunc(fin.content, 1500)}`)
      for (const w of scanToolSyntax(fin.content)) console.log(`   ⚠️ ${w}`)
      if (fin.taskSummary) console.log(`📌 taskSummary: ${trunc(fin.taskSummary, 400)}`)
    } else {
      console.log('(job không có result/error — bị dừng trước khi finalize)')
    }
    // FIX H r56: OPUS VERDICT của session — bằng chứng D3 ngay trong hậu kiểm
    try {
      const revs = db
        .query(`SELECT decision, triggerMode, verdict, createdAt FROM OpusReview WHERE sessionId = ? ORDER BY createdAt DESC LIMIT 3`)
        .all(job.sessionId) as any[]
      console.log('')
      console.log(`── OPUS VERDICT session này (${revs.length} review) ──`)
      if (revs.length === 0) console.log('(chưa có review nào — soi D3.1: run chính có được review đúng chế độ?)')
      for (const r of revs) {
        const lines = verdictLines(r, true)
        console.log(`${lines[0]} · ${new Date(r.createdAt).toISOString().slice(5, 16)}`)
        for (const l of lines.slice(1)) console.log(l)
      }
    } catch { /* bỏ qua */ }
    console.log('')
  }

  // timeline (đuôi)
  const shown = all.slice(-tailN)
  if (all.length > tailN) console.log(`… (bỏ ${all.length - tailN} event đầu — dùng --tail N để tăng)`)
  const repeat = new RepeatTracker()
  for (const e of shown) {
    console.log(fmtEvent(e))
    const w = repeat.check(e)
    if (w) console.log(`   ${w}`)
  }

  // phân tích lặp trên TOÀN BỘ run (không chỉ đuôi)
  console.log('')
  console.log('── Phân tích lặp (toàn run) ──')
  const groups = RepeatTracker.topGroups(all)
  if (groups.length === 0) console.log('✓ Không có nhóm tool nào lặp ≥5 lần cùng kết quả')
  for (const g of groups) console.log(g)

  // checkpoint: assistant contents + detector cú pháp
  if (job) {
    const ck = parseMaybeJson(job.checkpoint)
    const msgs: any[] = ck?.messages || []
    const asst = msgs.filter((m) => m.role === 'assistant')
    console.log('')
    console.log(`── Assistant content trong checkpoint (${msgs.length} messages, ${asst.length} assistant — đã qua nén CI-3) ──`)
    for (const [i, m] of asst.slice(-3).entries()) {
      console.log(`[${asst.length - Math.min(3, asst.length) + i + 1}/${asst.length}] (${m.content.length} chars): ${trunc(m.content, 500)}`)
      for (const w of scanToolSyntax(m.content)) console.log(`   ⚠️ ${w}`)
    }
    if (ck?.lastLlmError) console.log(`lastLlmError: ${trunc(ck.lastLlmError, 240)}`)
  }
  db.close()
}

// ─────────────────────────── main ───────────────────────────

const args = process.argv.slice(2)
if (args.includes('--follow')) {
  follow().catch((e) => {
    console.error('Lỗi follow:', e)
    process.exit(1)
  })
} else if (args.includes('--replay')) {
  const i = args.indexOf('--replay')
  const target = args[i + 1]
  const tIdx = args.indexOf('--tail')
  const tailN = tIdx >= 0 ? parseInt(args[tIdx + 1] || '50', 10) : 50
  if (!target) {
    console.error('Thiếu target: --replay <jobId | runId | file>')
    process.exit(1)
  }
  replay(target, isNaN(tailN) ? 50 : tailN)
} else {
  snapshot()
}
