/**
 * Agent Run Tracker — Thought Process + Todos + Progress realtime trong chat.
 *
 * User request 2026-08-31: muốn TẤT CẢ agents (độc lập + team) hiển thị trong
 * cửa sổ chat một khối "Thought Process" (mặc định đóng, bấm mở ra) chứa:
 *   - Quá trình tư duy của AI (mỗi vòng ReAct)
 *   - Todos list (✓ xong / ◐ đang làm / ○ chờ)
 *   - Tiến trình live: đã đọc bao nhiêu file, chạy bao nhiêu lệnh, kết quả thật
 *   - Trạng thái "Done" khi hoàn thành
 * (giống Thought Process + Todos của Claude Code / Z.ai Code / Cline).
 *
 * Kiến trúc — theo cùng pattern đã chứng minh của agent-activity-log.ts:
 *   - In-memory registry trên globalThis (fail-open: KHÔNG bao giờ làm hỏng
 *     agent execution; display-only).
 *   - ReAct loop (chat route + workflow-engine) gọi startAgentRun →
 *     recordAgentThought mỗi vòng LLM → endAgentRun khi xong.
 *   - executeTool() tự ghi tool events (kèm RESULT PREVIEW thật) vào run
 *     đang active của session → che MỌI paths (single chat, team, cron).
 *   - Frontend poll GET /api/agent-run?sessionId=... mỗi ~1.2s trong lúc
 *     chờ response (single chat là stream:false nên poll là cơ chế live).
 *
 * Data model:
 *   AgentRun  = 1 lần agent chạy ReAct loop (1 chat exchange hoặc 1 team step)
 *   RunEvent  = thought | tool | todo_update | run_start | run_end
 *
 * Task 20-b (self-monitoring): mỗi run KẾT THÚC (endAgentRun / user cancel)
 * được persist 1 row AgentRunRecord (SQLite) — fire-and-forget, fail-open.
 * Trước đây run lifecycle chỉ sống trong ChatMessage.metadata JSON + map
 * in-memory này (restart là mất). v1: cycles/tokensUsed/evaluatorConfidence/
 * messageId = null (goal-loop metadata — task 20-c sẽ wire); stopReason là
 * heuristic map từ status (complete|error|cancelled).
 *
 * Task 20-c (DEDUP — 1 run = đúng 1 row): goal-loop giờ TỰ persist lifecycle
 * AgentRunRecord (insertAgentRunRecordRunning lúc start + updateLatestAgentRunRecord
 * lúc end với đầy đủ metadata thật). Để tránh double-insert, startAgentRun nhận
 * dbPersistBy:'caller' → endAgentRun/cancelSessionRuns BỎ QUA persistAgentRunRecord
 * cho run đó (caller — goal-loop — chịu trách nhiệm DB). Run của Code Team
 * workflow-engine (mode 'team', mặc định 'tracker') giữ nguyên behavior 20-b:
 * tracker insert 1 row đầy đủ khi run kết thúc.
 */

// ROUND-11: insertAgentRunRecord/updateLatestAgentRunRecord giờ dynamic
// import trong persistAgentRunRecord (update-first) — bỏ static import.

// ROUND-23 P1 — durable event trail: fs/path cho append JSONL (fail-open).
import fs from 'node:fs'
import path from 'node:path'
// ROUND-50 (P3-ζ r49): làm sạch thought hiển thị — strip marker corruption
// provider (`]<]minimax[>[`) + ẩn khối tool-call dạng <invoke>…</invoke> của
// minimax khỏi phần text Suy nghĩ (tool call đã hiển thị là event riêng).
// tool-calls.ts chỉ import find-balanced-json — không cycle với module này.
import { stripProviderGarbleMarkers } from '@/lib/tool-calls'

// ==================== Types ====================

export interface AgentRunTodo {
  id: string
  content: string
  status: string
  priority?: string
  /** TASK 21-d — todo cha (lồng nhau): Thought Progress render CÂY qua parentId */
  parentId?: string | null
}

export type AgentRunEventType =
  | 'run_start'
  | 'thought'
  | 'tool'
  | 'todo_update'
  | 'run_end'

export interface AgentRunEvent {
  id: string
  ts: number
  type: AgentRunEventType
  /** thought text / task mô tả / end summary */
  text?: string
  /** Vòng ReAct (1-based) của thought/tool */
  iteration?: number
  /** Tool name (event type 'tool') */
  tool?: string
  /** Tóm tắt args: lệnh shell / path file / query... */
  argsSummary?: string
  /** Kết quả THẬT (stdout/stderr, content preview...) — truncated */
  resultPreview?: string
  success?: boolean
  durationMs?: number
  /** Snapshot todo list (event type 'todo_update') */
  todos?: AgentRunTodo[]
  /** run_end bị dừng bởi người dùng (bấm nút Dừng) — hiển thị ⏹ thay vì ✗ */
  cancelled?: boolean
}

export interface AgentRunCounters {
  iterations: number
  toolCalls: number
  filesRead: number
  commandsRun: number
  editsMade: number
  searches: number
}

export interface AgentRun {
  runId: string
  sessionId: string
  agentName: string
  agentPosition?: string
  step?: string
  /** Yêu cầu gốc (user message / team step prompt) — rút gọn */
  task?: string
  mode: 'standalone' | 'team'
  /** FIX 2026-09-14 #5: runId của run CHA (delegation) — persist lên
   * AgentRunRecord.parentRunId để truy vấn mọi sub-run của 1 run cha. */
  parentRunId?: string | null
  /** Task 20-c: ai chịu trách nhiệm persist AgentRunRecord ra DB?
   *  'tracker' (mặc định) — endAgentRun/cancelSessionRuns insert row khi run kết thúc
   *  'caller' — goal-loop tự insert lúc start + update đầy đủ metadata lúc end
   *             (tracker bỏ qua để không double-insert — 1 run = đúng 1 row) */
  dbPersistBy?: 'tracker' | 'caller'
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  /** r60 (C7) — stopReason thật caller truyền vào endAgentRun (vd 'concluded',
   * 'stall_brake', 'no_progress'...) — persist xuống AgentRunRecord.stopReason
   * thay cho mapping chung chung theo status. */
  stopReasonFinal?: string
  events: AgentRunEvent[]
  counters: AgentRunCounters
  lastTodos?: AgentRunTodo[]
  /** FIX 2026-09-15 #6 (P4 — audit Team Code): token usage thật của run (tích
   * lũy qua các LLM call trong ReAct loop) — endAgentRun nhận từ caller
   * (workflow-engine đã đếm stepTokensUsed), persist lên AgentRunRecord.
   * Trước đây tracker luôn ghi null → mất số liệu phân tích hiệu năng. */
  tokensUsed?: number
  /** ROUND-23 P1 — tổng số tool failure THẬT của run (không phụ thuộc cửa
   *  sổ event in-memory — trước đây persistAgentRunRecord đếm trong cửa sổ
   *  250-event nên run dài bị đếm thiếu: 3 nguồn cho 3 số khác nhau). */
  toolFailuresTotal?: number
}

// ==================== Storage (globalThis — shared across module instances) ====================

const MAX_RUNS_PER_SESSION = 10
// ROUND-23 P4: 250 → 120 — registry in-memory giờ chỉ còn là lớp HIỂN THỊ;
// bằng chứng đầy đủ đã append ra đĩa (appendEventTrail) nên giảm cap để bớt
// ăn RAM (worst case cũ 60×10×250 event × ~3.3KB ≈ hàng trăm MB → 30×10×120).
const MAX_EVENTS_PER_RUN = 120
const MAX_SESSIONS = 30
const THOUGHT_MAX_CHARS = 2400
const RESULT_PREVIEW_MAX_CHARS = 900

// ==================== ROUND-23 P1 — Durable event trail (JSONL trên đĩa) ====================
//
// BÀI HỌC ROUND-22 (mission MEGATRON audit memory 01-10): registry in-memory
// (250 event/run, trượt cửa sổ, XOÁ SẠCH khi restart) làm mất bằng chứng giữa
// chừng — 3 lần MemWatchdog self-exit xóa registry, agent phải chạy lại gate
// 4-5 lần chỉ để "cite" được việc đã làm, và 6 tool failure của run trước
// KHÔNG THỂ đối chiếu vì sự kiện đã bị evict.
//
// Giải pháp: MỌI event được append thêm ra agent-runs/<runId>.jsonl — bền vững
// qua restart + không bao giờ evict. Agent/operator đọc lại qua
// GET /api/agent-run?runId=<id>. Fail-open tuyệt đối như toàn bộ tracker:
// lỗi đĩa KHÔNG bao giờ làm hỏng agent execution.
//
// Thư mục agent-runs/ nằm trong danh sách infra-guard bảo vệ (chống agent tự
// sửa bằng chứng của mình) — đọc được, ghi đè thì không.
// r60 (C6 — leak jsonl lặp ≥2 phiên → fix cấu trúc theo nguyên tắc 4 giao
// thức): env TMO_AGENT_RUNS_DIR cho phép TÁCH thư mục ghi (quality-gate trỏ
// sang /tmp khi chạy bun test — test units ghi jsonl TEST-* đã 4 lần rơi vào
// agent-runs/ THẬT của repo: 14:46/15:29/15:41/16:34 trong các phiên 58-59;
// mặc định KHÔNG đặt env → giữ nguyên hành vi cũ).
const RUN_TRAILS_DIR = (process.env.TMO_AGENT_RUNS_DIR || '').trim() !== ''
  ? path.resolve((process.env.TMO_AGENT_RUNS_DIR || '').trim())
  : path.join(process.cwd(), 'agent-runs')
/** Chống path traversal qua runId (runId do hệ sinh, nhưng phòng xa) */
const RUN_ID_SAFE_RE = /^[A-Za-z0-9_-]{1,80}$/

/** Chuỗi hoá append THEO TỪNG RUN (smoke round-23 phát hiện fs.appendFile
 * fire-and-forget chạy ĐUA nhau → run_end có thể nhảy lên trước tool event
 * cuối — log bằng chứng đọc sai trình tự. Mỗi run 1 promise-chain → giữ
 * thứ tự; map tự dọn entry khi chain rỗng.)
 * ROUND-25 fix: chuyển Map + flag dir-ready lên globalThis (mirror pattern
 * storage của file này — xem 'Storage (globalThis)' phía dưới): Turbopack HMR
 * swap module giữa chừng run cho ra 2 instance với 2 Map riêng → chuỗi append
 * của cùng runId chạy đua 2 nhánh → event có thể lệch thứ tự. Trên globalThis
 * chỉ còn MỘT chuỗi xuyên suốt vòng đời module. */
const trailGlobal = globalThis as unknown as {
  __tmoTrailWriteChains?: Map<string, Promise<void>>
  __tmoRunTrailsDirReady?: boolean
}
const trailWriteChains: Map<string, Promise<void>> =
  trailGlobal.__tmoTrailWriteChains ?? (trailGlobal.__tmoTrailWriteChains = new Map())

function appendEventTrail(run: AgentRun, event: AgentRunEvent): void {
  try {
    if (!RUN_ID_SAFE_RE.test(run.runId)) return
    if (!trailGlobal.__tmoRunTrailsDirReady) {
      fs.mkdirSync(RUN_TRAILS_DIR, { recursive: true })
      trailGlobal.__tmoRunTrailsDirReady = true
    }
    const file = path.join(RUN_TRAILS_DIR, `${run.runId}.jsonl`)
    const line =
      JSON.stringify({
        ...event,
        runId: run.runId,
        sessionId: run.sessionId,
        agentName: run.agentName,
      }) + '\n'
    const prev = trailWriteChains.get(run.runId) ?? Promise.resolve()
    const p = prev
      .then(() => new Promise<void>(resolve => { fs.appendFile(file, line, () => resolve()) }))
      .catch(() => { /* fail-open — trail là lớp phụ */ })
      .then(() => {
        if (trailWriteChains.get(run.runId) === p) trailWriteChains.delete(run.runId)
      })
    trailWriteChains.set(run.runId, p)
  } catch { /* fail-open — trail là lớp phụ, registry chính vẫn chạy */ }
}

/** Kết quả đọc trail từ đĩa (ROUND-23 P1). */
export interface RunTrail {
  ok: boolean
  runId: string
  events: AgentRunEvent[]
  /** Tổng event THẬT của run trên đĩa (kể cả phần trượt cửa sổ) */
  totalEvents: number
  /** true nếu events đã cắt về `limit` event gần nhất (file đầy đủ trên đĩa) */
  truncatedToWindow: boolean
  note?: string
}

/**
 * Đọc lại toàn bộ/lượt cuối event của 1 run BẤT KỂ LÚC NÀO (sau restart, sau
 * eviction) — nguồn nhận chứng cho agent + operator. Mỗi dòng JSONL đã đóng
 * dấu runId/sessionId/agentName nên đối chiếu được identity.
 */
export async function readRunTrail(runId: string, limit = 250): Promise<RunTrail> {
  const base: RunTrail = { ok: false, runId, events: [], totalEvents: 0, truncatedToWindow: false }
  try {
    if (!RUN_ID_SAFE_RE.test(runId)) return { ...base, note: 'runId không hợp lệ' }
    const file = path.join(RUN_TRAILS_DIR, `${runId}.jsonl`)
    const raw = await fs.promises.readFile(file, 'utf-8')
    const events: AgentRunEvent[] = []
    for (const line of raw.split('\n')) {
      const l = line.trim()
      if (!l) continue
      try { events.push(JSON.parse(l) as AgentRunEvent) } catch { /* dòng hỏng — bỏ qua */ }
    }
    const totalEvents = events.length
    const window = limit > 0 ? events.slice(-limit) : events
    return {
      ok: true,
      runId,
      events: window,
      totalEvents,
      truncatedToWindow: totalEvents > window.length,
      note:
        totalEvents > window.length
          ? `trượt cửa sổ: trả ${window.length}/${totalEvents} event gần nhất — tăng limit hoặc đọc file để có toàn bộ`
          : undefined,
    }
  } catch {
    return {
      ...base,
      note: 'không tìm thấy trail trên đĩa (run trước round-23, run chưa ghi, hoặc runId sai)',
    }
  }
}

interface RunRegistry {
  runsBySession: Map<string, AgentRun[]>
  /** runId đang active (đang chạy) cho mỗi session — executeTool ghi vào đây */
  activeRunBySession: Map<string, string>
  /** USER REQUEST 2026-08-31 (bấm nút Gửi để Dừng tác vụ): session bị user hủy —
   *  Map<sessionId, cancelledAtTs>. ReAct loops (chat route + workflow-engine)
   *  và cả chuỗi xoay vòng key LLM kiểm tra flag này để cắt ngang sớm.
   *  startAgentRun của session XÓA flag (hủy chỉ tác dụng lên các run ĐANG chạy,
   *  không giết request mới). Entries quá CANCEL_TTL_MS tự expire. */
  cancelledSessions: Map<string, number>
}

/** Thời gian flag cancel có hiệu lực (ms) — đủ dài để mọi loop trong-flight thấy */
const CANCEL_FLAG_TTL_MS = 10 * 60 * 1000

const globalForRuns = globalThis as unknown as {
  __tmoAgentRunTracker?: RunRegistry
}

function registry(): RunRegistry {
  if (!globalForRuns.__tmoAgentRunTracker) {
    globalForRuns.__tmoAgentRunTracker = {
      runsBySession: new Map(),
      activeRunBySession: new Map(),
      cancelledSessions: new Map(),
    }
  }
  return globalForRuns.__tmoAgentRunTracker
}

let eventSeq = 0
let runSeq = 0

function nextEventId(): string {
  return `re_${Date.now()}_${++eventSeq}`
}

function truncateText(text: string | undefined | null, max: number): string | undefined {
  if (!text) return undefined
  const s = String(text)
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function trimSessions() {
  const reg = registry()
  if (reg.runsBySession.size <= MAX_SESSIONS) return
  // Xóa session cũ nhất (theo run cuối cùng) — LRU thô
  const sorted = Array.from(reg.runsBySession.entries()).sort(
    (a, b) =>
      (a[1][a[1].length - 1]?.startedAt || 0) -
      (b[1][b[1].length - 1]?.startedAt || 0),
  )
  const toRemove = sorted.slice(0, reg.runsBySession.size - MAX_SESSIONS)
  for (const [sid] of toRemove) {
    reg.runsBySession.delete(sid)
    reg.activeRunBySession.delete(sid)
    reg.cancelledSessions.delete(sid)
  }
}

function runsOf(sessionId: string): AgentRun[] {
  const reg = registry()
  let arr = reg.runsBySession.get(sessionId)
  if (!arr) {
    arr = []
    reg.runsBySession.set(sessionId, arr)
  }
  return arr
}

function activeRun(sessionId: string | null | undefined): AgentRun | null {
  if (!sessionId) return null
  const reg = registry()
  const runId = reg.activeRunBySession.get(sessionId)
  if (runId) {
    const run = runsOf(sessionId).find(r => r.runId === runId)
    if (run && run.status === 'running') return run
  }
  // FALLBACK (user report 2026-09-29: "session đang vận hành không hiện dấu
  // đang chạy"): con trỏ activeRunBySession là SINGLE-SLOT — khi run thứ 2
  // gọi startAgentRun cho cùng session (vd OPUS review chạy giữa chừng
  // goal-loop job), nó ĐÈ LÊN con trỏ; khi run đó endAgentRun thì con trỏ bị
  // XÓA trong khi run thứ nhất (goal-loop) vẫn 'running' (vẫn hiện ở
  // /api/agent-run nhưng hasActiveRun → false → chấm xanh tắt + UI ngừng
  // poll). Quét run list của session, trả về run 'running' MỚI NHẤT.
  const runs = reg.runsBySession.get(sessionId)
  if (runs && runs.length > 0) {
    for (let i = runs.length - 1; i >= 0; i--) {
      if (runs[i].status === 'running') return runs[i]
    }
  }
  return null
}

function pushEvent(run: AgentRun, event: AgentRunEvent) {
  run.events.push(event)
  if (run.events.length > MAX_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_EVENTS_PER_RUN)
  }
  // ROUND-23 P1 — ghi bền vững ra đĩa (append-only, fail-open)
  appendEventTrail(run, event)
}

// ==================== AgentRunRecord persistence (Task 20-b) ====================

/** Map tracker status → AgentRunRecord.status */
function runStatusToRecordStatus(status: AgentRun['status']): string {
  if (status === 'done') return 'completed'
  if (status === 'error') return 'failed'
  return 'cancelled'
}

/**
 * Persist 1 AgentRunRecord row khi run kết thúc — fire-and-forget, fail-open
 * ( KHÔNG await, KHÔNG throw — display/tracking không được phép làm hỏng run).
 * Chỉ gọi khi run CHUYỂN từ 'running' sang trạng thái kết thúc (đảm bảo 1 row/run,
 * không sinh trùng khi endAgentRun bị gọi lại cho run đã kết thúc).
 */
function persistAgentRunRecord(run: AgentRun): void {
  try {
    const endedAt = run.endedAt ?? Date.now()
    // ROUND-23 P1 — đếm tổng THẬT (run.toolFailuresTotal) thay vì đếm trong
    // cửa sổ event in-memory (run dài trước đây chỉ đếm được phần còn lại:
    // ToolMetric=6, registry=3, AgentRunRecord=2 — 3 nguồn 3 số).
    const toolFailures =
      run.toolFailuresTotal ??
      run.events.filter(e => e.type === 'tool' && e.success === false).length
    // ROUND-11 — UPDATE-FIRST rồi mới INSERT-fallback: delegation giờ insert
    // row 'running' NGAY lúc start (subagent-delegate — chống mất trắng khi
    // restart giết subagent giữa chừng). Blind insert ở đây sẽ tạo DOUBLE ROW
    // cho mọi delegation kết thúc bình thường. Update row start (khớp
    // sessionId+runId) với metadata đầy đủ; update khớp 0 dòng (đường cũ
    // không có row start / db bị wipe) → fallback insert như trước.
    const endData: import('@/lib/metrics-db').AgentRunRecordUpdate = {
      agentName: run.agentName,
      status: runStatusToRecordStatus(run.status),
      // v1 heuristic — stopReason budget thật (max_cycles/time_budget/
      // token_budget/no_progress) nằm trong goal-loop, task 20-c wire
      // r60 (C7): caller truyền stopReasonFinal (vd 'stall_brake'/'concluded'
      // của delegation) → dùng nó; không có → mapping cũ.
      stopReason: run.stopReasonFinal ?? (run.status === 'done' ? 'complete' : run.status === 'error' ? 'error' : 'cancelled'),
      ...(run.tokensUsed != null ? { tokensUsed: run.tokensUsed } : {}), // FIX 2026-09-15 #6: token thật từ caller
      // r60 (C7) — cycles: recordAgentThought đã track counters.iterations =
      // max vòng đã ghi; trước đây luôn null → sub-agent rows không hiện số vòng
      // (update type là number|undefined — null chỉ hợp lệ ở nhánh insert)
      cycles: run.counters.iterations > 0 ? run.counters.iterations : undefined,
      toolCalls: run.counters.toolCalls,
      toolFailures,
      durationMs: Math.max(0, endedAt - run.startedAt),
      complete: run.status === 'done',
      completedAt: new Date(endedAt),
    }
    void (async () => {
      try {
        const { updateLatestAgentRunRecord } = await import('@/lib/metrics-db')
        const updated = await updateLatestAgentRunRecord(run.sessionId, endData, run.runId)
        if (updated > 0) return // row start đã có — update xong, không insert
        // Fallback — đường cũ (row start chưa tồn tại): insert full
        const { insertAgentRunRecord } = await import('@/lib/metrics-db')
        await insertAgentRunRecord({
          sessionId: run.sessionId,
          // FIX 2026-09-14 #5 — wire runId + parentRunId: delegation rows
          // (sub_xxx) giờ truy vấn được theo run (runId) + theo run cha
          // (parentRunId) từ AgentRunRecord.
          runId: run.runId,
          parentRunId: run.parentRunId ?? null,
          messageId: null, // 20-c: wire ChatMessage id từ goal-loop
          agentId: null, // 20-c: wire agentId (tracker chỉ có agentName)
          agentName: run.agentName,
          status: runStatusToRecordStatus(run.status),
          stopReason: run.stopReasonFinal ?? (run.status === 'done' ? 'complete' : run.status === 'error' ? 'error' : 'cancelled'),
          // r60 (C7) — cycles thật từ counters (trước đây null cứng)
          cycles: run.counters.iterations > 0 ? run.counters.iterations : null,
          tokensUsed: run.tokensUsed ?? null,
          toolCalls: run.counters.toolCalls,
          toolFailures,
          durationMs: Math.max(0, endedAt - run.startedAt),
          evaluatorConfidence: null, // 20-c: wire evaluator verdict confidence
          complete: run.status === 'done',
          startedAt: new Date(run.startedAt),
          completedAt: new Date(endedAt),
        })
      } catch {
        /* fail-open — không crash run vì lỗi metrics */
      }
    })()
  } catch { /* fail-open */ }
}

// ==================== Public API ====================

/**
 * Bắt đầu 1 run mới cho agent. Trả về runId (hoặc null nếu sessionId rỗng —
 * vẫn fail-open, không throw bao giờ).
 */
export function startAgentRun(params: {
  sessionId?: string | null
  agentName: string
  agentPosition?: string
  step?: string
  task?: string
  mode?: 'standalone' | 'team'
  /** Task 20-c — 'caller' = goal-loop tự persist AgentRunRecord (dedup) */
  dbPersistBy?: 'tracker' | 'caller'
  /**
   * CI-5 (Task 14-b) — runId override cho RESUME durable goal-loop: run khôi
   * phục từ checkpoint phải DÙNG LẠI runId cũ (todos CI-2 keyed theo runId +
   * AgentRunRecord + panel Thought Process liền mạch "1 chat run = 1 run").
   * Không truyền / rỗng → sinh mới như cũ (behavior mọi caller hiện có giữ
   * nguyên 100%).
   */
  runId?: string
}): string | null {
  try {
    const { sessionId, agentName } = params
    if (!sessionId) return null
    const reg = registry()
    // USER REQUEST 2026-08-31: run MỚI xóa flag cancel của session — việc dừng
    // chỉ tác dụng lên các run đang chạy, không giết request kế tiếp của user.
    reg.cancelledSessions.delete(sessionId)
    const run: AgentRun = {
      runId: params.runId && params.runId.trim() !== '' ? params.runId : `run_${Date.now()}_${++runSeq}`,
      sessionId,
      agentName: agentName.slice(0, 40),
      agentPosition: params.agentPosition?.slice(0, 12),
      step: truncateText(params.step, 120),
      task: truncateText(params.task, 240),
      mode: params.mode || 'standalone',
      dbPersistBy: params.dbPersistBy === 'caller' ? 'caller' : 'tracker',
      startedAt: Date.now(),
      status: 'running',
      events: [],
      counters: { iterations: 0, toolCalls: 0, filesRead: 0, commandsRun: 0, editsMade: 0, searches: 0 },
    }
    const arr = runsOf(sessionId)
    arr.push(run)
    if (arr.length > MAX_RUNS_PER_SESSION) {
      arr.splice(0, arr.length - MAX_RUNS_PER_SESSION)
    }
    reg.activeRunBySession.set(sessionId, run.runId)
    trimSessions()
    pushEvent(run, {
      id: nextEventId(),
      ts: Date.now(),
      type: 'run_start',
      text: run.task,
    })
    return run.runId
  } catch {
    return null
  }
}

/**
 * Kết thúc run. status 'done' | 'error' | 'cancelled'. Tự clear active run của
 * session nếu run đang kết thúc chính là run active.
 */
export function endAgentRun(
  sessionId: string | null | undefined,
  runId: string | null | undefined,
  status: 'done' | 'error' | 'cancelled',
  summary?: string,
  /** FIX 2026-09-15 #6 (P4): token usage thật tích lũy của run — optional,
   * mọi caller cũ không truyền giữ behavior nguyên vẹn. */
  tokensUsed?: number,
  /** r60 (C7) — stopReason THẬT của run (vd 'concluded'/'stall_brake'/
   * 'no_progress'/'token_budget'/'timeout' của delegation) — trước đây mọi
   * delegation kết thúc 'done' đều ghi stopReason 'complete' chung chung,
   * mất khả năng phân loại sự cố qua SQL (bằng chứng r59: hậu kiểm phải đọc
   * text run_end thay vì truy vấn cột). Không truyền → giữ mapping cũ. */
  stopReason?: string,
): void {
  try {
    if (!sessionId) return
    const reg = registry()
    const run = runId
      ? runsOf(sessionId).find(r => r.runId === runId)
      : activeRun(sessionId)
    if (!run) return
    // Chỉ persist AgentRunRecord khi run ĐANG running (chuyển đổi đầu tiên sang
    // trạng thái kết thúc) — tránh ghi trùng khi endAgentRun được gọi 2 lần.
    // Task 20-c: run do CALLER (goal-loop) persist thì tracker bỏ qua (dedup).
    const wasRunning = run.status === 'running'
    run.status = status
    run.endedAt = Date.now()
    // FIX 2026-09-15 #6 (P4): gắn token thật trước khi persist (nếu caller truyền)
    if (typeof tokensUsed === 'number' && tokensUsed > 0) {
      run.tokensUsed = tokensUsed
    }
    // r60 (C7) — stopReason thật của run (nếu caller truyền)
    if (stopReason && stopReason.trim() !== '') {
      run.stopReasonFinal = stopReason.trim().slice(0, 40)
    }
    pushEvent(run, {
      id: nextEventId(),
      ts: Date.now(),
      type: 'run_end',
      success: status === 'done',
      cancelled: status === 'cancelled',
      text: truncateText(summary, 300),
    })
    if (reg.activeRunBySession.get(sessionId) === run.runId) {
      reg.activeRunBySession.delete(sessionId)
      // FIX 2026-09-29 (cùng bản vá với activeRun fallback): run này kết thúc
      // nhưng session còn run KHÁC 'running' (vd goal-loop job dài hơi trong
      // khi OPUS review ngắn chạy đè con trỏ rồi kết thúc trước) → trỏ lại
      // run đang chạy mới nhất thay vì để con trỏ trống (hasActiveRun sai).
      const remaining = runsOf(sessionId).filter(r => r.status === 'running')
      const next = remaining[remaining.length - 1]
      if (next) reg.activeRunBySession.set(sessionId, next.runId)
    }
    if (wasRunning && run.dbPersistBy !== 'caller') persistAgentRunRecord(run)
  } catch { /* fail-open */ }
}

// ==================== CANCEL (user request 2026-08-31) ====================

/**
 * USER HỦY TÁC VỤ (bấm nút Gửi/Dừng): đánh dấu session bị cancel.
 *  - Mọi run đang 'running' của session → status 'cancelled' + run_end event.
 *  - ReAct loops (chat route + workflow-engine) + chuỗi xoay vòng key LLM kiểm
 *    tra isSessionCancelled() để cắt ngang sớm (giữa các vòng / trước mỗi attempt).
 *  - startAgentRun tiếp theo của session sẽ XÓA flag → request mới không bị ảnh hưởng.
 */
export function cancelSessionRuns(sessionId: string | null | undefined): number {
  try {
    if (!sessionId) return 0
    const reg = registry()
    const now = Date.now()
    // Dọn flag hết hạn
    for (const [sid, ts] of reg.cancelledSessions) {
      if (now - ts > CANCEL_FLAG_TTL_MS) reg.cancelledSessions.delete(sid)
    }
    reg.cancelledSessions.set(sessionId, now)

    let cancelledCount = 0
    const runs = reg.runsBySession.get(sessionId) || []
    for (const run of runs) {
      if (run.status === 'running') {
        run.status = 'cancelled'
        run.endedAt = now
        pushEvent(run, {
          id: nextEventId(),
          ts: now,
          type: 'run_end',
          success: false,
          cancelled: true,
          text: 'Đã dừng bởi người dùng',
        })
        // Task 20-c: run do caller (goal-loop) persist → tracker không insert
        // (goal-loop sẽ update row 'running' thành cancelled khi loop thoát)
        if (run.dbPersistBy !== 'caller') persistAgentRunRecord(run)
        cancelledCount++
      }
    }
    reg.activeRunBySession.delete(sessionId)
    console.log(`[AgentRun] 🛑 Session ${sessionId} bị user HỦY — ${cancelledCount} run(s) đang chạy → cancelled`)
    return cancelledCount
  } catch {
    return 0
  }
}

/** Session có đang bị user hủy không? (flag TTL 10 phút; startAgentRun xóa flag) */
export function isSessionCancelled(sessionId: string | null | undefined): boolean {
  try {
    if (!sessionId) return false
    const reg = registry()
    const ts = reg.cancelledSessions.get(sessionId)
    if (ts == null) return false
    if (Date.now() - ts > CANCEL_FLAG_TTL_MS) {
      reg.cancelledSessions.delete(sessionId)
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Ghi thought (output LLM của 1 vòng ReAct — phần reasoning TRƯỚC tool_call).
 * `content` thô: phần trước "tool_call:" được giữ làm reasoning; phần
 * tool_call syntax bị bỏ (tools hiển thị thành event riêng — giống Claude Code).
 *
 * ROUND-55 FIX G — DELEGATION CONTRACT (mirror recordAgentRunTool 2026-09-12):
 * truyền `runId` để ghi thought vào run CỤ THỂ (sub-agent được delegate) thay
 * vì run active của session (parent). Không truyền → giữ nguyên hành vi cũ.
 * Bằng chứng blind spot: mission SENTINEL r54 — sub_*.jsonl có 172 tool events
 * mà 0 thought event → operator thấy sub-agent LÀM GÌ nhưng KHÔNG thấy NGHĨ GÌ
 * (user 2026-10-07: "quan sát nhưng không quan sát cả các phần suy nghĩ của
 * agents → bỏ sót").
 */
export function recordAgentThought(
  sessionId: string | null | undefined,
  content: string | null | undefined,
  iteration?: number,
  runId?: string,
): void {
  try {
    const run = runId
      ? runsOf(sessionId || '').find(r => r.runId === runId && r.status === 'running') || null
      : activeRun(sessionId)
    if (!run || !content) return
    run.counters.iterations = Math.max(run.counters.iterations, iteration || 0)
    // Tách reasoning khỏi khối tool_call: tool calls hiển thị là event riêng
    // ROUND-50 FIX (P3-ζ): (a) strip marker corruption provider (space-bunny
    // leak `]<]minimax[>[` — bằng chứng user nhìn thấy nguyên văn trong panel
    // Suy nghĩ); (b) cắt khối tool call dạng <invoke…>…</invoke> (format minimax
    // — kể cả bản parse THÀNH CÔNG vẫn nằm lại trong content vì recordAgentThought
    // nhận content THÔ trước tầng parse); (c) giữ nguyên split `tool_call:` cũ.
    let thought = stripProviderGarbleMarkers(String(content))
    thought = thought.replace(/<invoke[\s\S]*?<\/invoke>/g, ' ') // khối invoke hoàn chỉnh (kèm args)
    thought = thought.replace(/<\/?invoke[^>\n]*>/g, ' ') // thẻ invoke rời rạc ĐÚNG ĐỊNH DẠNG (có `>` đóng); thẻ mỏng cụt không `>` (vd `</invoke name="?…`) giữ lại — text sau nó là suy nghĩ thật
    const openInvokeIdx = thought.indexOf('<invoke')
    if (openInvokeIdx >= 0) thought = thought.slice(0, openInvokeIdx) // invoke bị cắt cụt (không có thẻ đóng)
    const tcIdx = thought.search(/tool_call\s*:/i)
    let hadToolCalls = false
    if (tcIdx >= 0) {
      thought = thought.slice(0, tcIdx)
      hadToolCalls = true
    }
    thought = thought.trim()
    if (!thought) {
      // Native FC mode: content có thể rỗng, chỉ có tool_calls → vẫn ghi marker
      if (hadToolCalls) {
        pushEvent(run, {
          id: nextEventId(),
          ts: Date.now(),
          type: 'thought',
          iteration,
          text: '(gọi tool trực tiếp)',
        })
      }
      return
    }
    pushEvent(run, {
      id: nextEventId(),
      ts: Date.now(),
      type: 'thought',
      iteration,
      text: truncateText(thought, THOUGHT_MAX_CHARS),
    })
  } catch { /* fail-open */ }
}

/** Nhóm tool → counter nào tăng */
function counterFor(tool: string): keyof AgentRunCounters | null {
  if (tool === 'shell' || tool === 'run_bg') return 'commandsRun'
  if (tool === 'file_read' || tool === 'file_list' || tool === 'grep') return 'filesRead'
  if (tool === 'file_edit' || tool === 'file_multi_edit' || tool === 'file_delete') return 'editsMade'
  if (
    tool === 'knowledge_search' || tool === 'tavily' || tool === 'serper' ||
    tool === 'jina' || tool === 'web_search' || tool === 'web_fetch'
  ) return 'searches'
  return null
}

/**
 * Ghi 1 tool execution (kèm kết quả thật) vào run đang active của session.
 * Được gọi từ executeTool() — che mọi paths: single chat, team, cron.
 */
export function recordAgentRunTool(
  sessionId: string | null | undefined,
  entry: {
    tool: string
    argsSummary?: string
    success: boolean
    durationMs: number
    resultPreview?: string
    iteration?: number
  },
  /**
   * DELEGATION CONTRACT (fix 2026-09-12): truyền runId để ghi event vào run
   * CỤ THỂ (run sub-agent được delegate) thay vì run active của session.
   * Không truyền → giữ nguyên hành vi cũ (run active — parent run).
   */
  runId?: string,
): void {
  try {
    const run = runId
      ? runsOf(sessionId || '').find(r => r.runId === runId && r.status === 'running') || null
      : activeRun(sessionId)
    if (!run) return
    run.counters.toolCalls++
    // ROUND-23 P1 — đếm tổng failure THẬT của run (thoát khỏi cửa sổ event)
    if (entry.success === false) {
      run.toolFailuresTotal = (run.toolFailuresTotal || 0) + 1
    }
    const counter = counterFor(entry.tool)
    if (counter) run.counters[counter]++
    pushEvent(run, {
      id: nextEventId(),
      ts: Date.now(),
      type: 'tool',
      tool: entry.tool.slice(0, 40),
      argsSummary: truncateText(entry.argsSummary, 200),
      success: entry.success,
      durationMs: Math.max(0, Math.round(entry.durationMs || 0)),
      resultPreview: truncateText(entry.resultPreview, RESULT_PREVIEW_MAX_CHARS),
    })
    // todo_write → capture snapshot todo list cho panel Todos
    // (shape: { success, sessionId, upserted, todos: [...] })
    if (entry.tool === 'todo_write' && entry.success) {
      // caller truyền thêm qua recordAgentRunTodos bên dưới
    }
  } catch { /* fail-open */ }
}

// ==================== DELEGATION RUNS (fix 2026-09-12) ====================

/**
 * DELEGATION CONTRACT — đăng ký run cho SUB-AGENT được delegate.
 *
 * GAP được vá (so sánh quy trình orchestrator Claude-Code với TMO 2026-09-12):
 * sub-agent chạy minh bạch — user thấy run riêng trong panel Thought Process
 * (kèm todo kế hoạch + tool events của sub-agent), todos gắn đúng session +
 * runId (không còn rơi scope 'default' vô hình).
 *
 * KHÁC startAgentRun ở 3 điểm (quan trọng — không thay thế nhau):
 *  (1) KHÔNG xóa flag cancel của session — parent run đang chạy; user bấm
 *      Dừng giữa chừng phải cắt được cả sub-agent (isSessionCancelled check
 *      trong mini loop của subagent-delegate);
 *  (2) KHÔNG chiếm activeRunBySession — recordAgentRunTool/recordAgentThought
 *      của PARENT tiếp tục ghi vào run parent (event của sub-agent ghi qua
 *      tham số runId riêng);
 *  (3) không set dbPersistBy='caller' — endAgentRun tự persist AgentRunRecord
 *      (1 row cho mỗi delegation — nhìn lại lịch sử delegation trong DB).
 *
 * Fail-open như mọi API tracker: lỗi → null (delegation vẫn chạy bình thường,
 * chỉ thiếu hiển thị).
 */
export function registerDelegationRun(params: {
  sessionId?: string | null
  /** runId của parent (goal-loop / pipeline step) — chỉ để hiển thị nguồn giao việc */
  parentRunId?: string | null
  agentName: string
  /** position thật của sub-agent (TL/G1/G2-A/G2-B/G3) — hiển thị màu đúng trong UI */
  agentPosition?: string
  task?: string
}): string | null {
  try {
    const { sessionId, agentName } = params
    if (!sessionId) return null
    const reg = registry()
    const run: AgentRun = {
      runId: `sub_${Date.now()}_${++runSeq}`,
      sessionId,
      agentName: agentName.slice(0, 40),
      agentPosition: params.agentPosition?.slice(0, 12),
      step: params.parentRunId
        ? `delegated bởi ${params.parentRunId.slice(0, 16)}`
        : 'delegated',
      task: truncateText(params.task, 240),
      mode: 'team',
      // FIX 2026-09-14 #5: persist parentRunId lên AgentRunRecord — query
      // "mọi delegation rows của run X" giờ chạy được qua cột parentRunId.
      parentRunId: params.parentRunId ?? null,
      dbPersistBy: 'tracker',
      startedAt: Date.now(),
      status: 'running',
      events: [],
      counters: { iterations: 0, toolCalls: 0, filesRead: 0, commandsRun: 0, editsMade: 0, searches: 0 },
    }
    const arr = runsOf(sessionId)
    arr.push(run)
    if (arr.length > MAX_RUNS_PER_SESSION) {
      arr.splice(0, arr.length - MAX_RUNS_PER_SESSION)
    }
    trimSessions()
    pushEvent(run, {
      id: nextEventId(),
      ts: Date.now(),
      type: 'run_start',
      text: `[Delegation] ${run.task || ''}`,
    })
    return run.runId
  } catch {
    return null
  }
}

/**
 * Ghi snapshot todo list (từ kết quả todo_write hoặc auto-todo của workflow).
 * runId (fix 2026-09-12 delegation): ghi vào run cụ thể của sub-agent thay vì
 * run active của parent — todo plan của sub-agent không đè lastTodos parent.
 */
export function recordAgentRunTodos(
  sessionId: string | null | undefined,
  todos: AgentRunTodo[],
  runId?: string,
): void {
  try {
    const run = runId
      ? runsOf(sessionId || '').find(r => r.runId === runId && r.status === 'running') || null
      : activeRun(sessionId)
    if (!run || !Array.isArray(todos) || todos.length === 0) return
    run.lastTodos = todos.slice(0, 50).map(t => ({
      id: String(t.id || ''),
      content: String(t.content || '').slice(0, 160),
      status: String(t.status || 'pending'),
      priority: t.priority ? String(t.priority) : undefined,
      // TASK 21-d — giữ parentId để panel render todo CON lồng đúng chỗ
      parentId: t.parentId ? String(t.parentId) : null,
    }))
    pushEvent(run, {
      id: nextEventId(),
      ts: Date.now(),
      type: 'todo_update',
      todos: run.lastTodos,
    })
  } catch { /* fail-open */ }
}

/**
 * Lấy các runs của session (mới nhất cuối) — cho GET /api/agent-run.
 * Trả về snapshot serializable (events đã capped).
 */
export function getAgentRuns(sessionId: string, limit = 12): AgentRun[] {
  try {
    const arr = registry().runsBySession.get(sessionId) || []
    return arr.slice(-Math.max(1, Math.min(limit, 30))).map(r => ({
      ...r,
      events: r.events.slice(-MAX_EVENTS_PER_RUN),
    }))
  } catch {
    return []
  }
}

/** Có run nào đang chạy cho session không (frontend dùng để quyết định poll) */
export function hasActiveRun(sessionId: string): boolean {
  return activeRun(sessionId) !== null
}

/** USER REPORT 2026-09-29 ("session đang vận hành không hiện ra"): danh sách
 *  MỌI sessionId đang có ít nhất 1 run 'running' trong tracker in-memory.
 *  /api/openclaw/sessions dùng để trả `activeSessions` (không lọc theo
 *  agent/team) — session đang vận hành bởi agent KHÁC (goal-loop job tự
 *  dispatch, OPUS chỉ đạo…) luôn xuất hiện ở dropdown mọi ngữ cảnh. */
export function getActiveRunSessionIds(): string[] {
  try {
    const reg = registry()
    const out: string[] = []
    for (const [sid, runs] of reg.runsBySession) {
      if (runs.some(r => r.status === 'running')) out.push(sid)
    }
    return out
  } catch {
    return []
  }
}

/**
 * CI-2 (Task 11-a) — Lấy runId của run ĐANG ACTIVE (status='running') của
 * session. Chat route dùng ở CRASH-PATH: goal loop văng exception ra ngoài
 * trước khi endAgentRun được gọi → cần runId để đóng todo của run đó một cách
 * trung thực (in_progress → 'failed', pending → 'archived' — xem
 * closeRunTodosAtEnd trong dev-tools TODO section).
 * Trả null nếu session không có run đang chạy (hoặc lỗi — fail-open).
 */
export function getActiveRunId(sessionId: string | null | undefined): string | null {
  try {
    const run = activeRun(sessionId)
    return run ? run.runId : null
  } catch {
    return null
  }
}
