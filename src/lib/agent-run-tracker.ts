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
 */

// ==================== Types ====================

export interface AgentRunTodo {
  id: string
  content: string
  status: string
  priority?: string
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
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  events: AgentRunEvent[]
  counters: AgentRunCounters
  lastTodos?: AgentRunTodo[]
}

// ==================== Storage (globalThis — shared across module instances) ====================

const MAX_RUNS_PER_SESSION = 10
const MAX_EVENTS_PER_RUN = 250
const MAX_SESSIONS = 60
const THOUGHT_MAX_CHARS = 2400
const RESULT_PREVIEW_MAX_CHARS = 900

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
  if (!runId) return null
  const run = runsOf(sessionId).find(r => r.runId === runId)
  return run && run.status === 'running' ? run : null
}

function pushEvent(run: AgentRun, event: AgentRunEvent) {
  run.events.push(event)
  if (run.events.length > MAX_EVENTS_PER_RUN) {
    run.events.splice(0, run.events.length - MAX_EVENTS_PER_RUN)
  }
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
}): string | null {
  try {
    const { sessionId, agentName } = params
    if (!sessionId) return null
    const reg = registry()
    // USER REQUEST 2026-08-31: run MỚI xóa flag cancel của session — việc dừng
    // chỉ tác dụng lên các run đang chạy, không giết request kế tiếp của user.
    reg.cancelledSessions.delete(sessionId)
    const run: AgentRun = {
      runId: `run_${Date.now()}_${++runSeq}`,
      sessionId,
      agentName: agentName.slice(0, 40),
      agentPosition: params.agentPosition?.slice(0, 12),
      step: truncateText(params.step, 120),
      task: truncateText(params.task, 240),
      mode: params.mode || 'standalone',
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
): void {
  try {
    if (!sessionId) return
    const reg = registry()
    const run = runId
      ? runsOf(sessionId).find(r => r.runId === runId)
      : activeRun(sessionId)
    if (!run) return
    run.status = status
    run.endedAt = Date.now()
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
    }
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
 */
export function recordAgentThought(
  sessionId: string | null | undefined,
  content: string | null | undefined,
  iteration?: number,
): void {
  try {
    const run = activeRun(sessionId)
    if (!run || !content) return
    run.counters.iterations = Math.max(run.counters.iterations, iteration || 0)
    // Tách reasoning khỏi khối tool_call: tool calls hiển thị là event riêng
    let thought = String(content)
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
export function recordAgentRunTool(sessionId: string | null | undefined, entry: {
  tool: string
  argsSummary?: string
  success: boolean
  durationMs: number
  resultPreview?: string
  iteration?: number
}): void {
  try {
    const run = activeRun(sessionId)
    if (!run) return
    run.counters.toolCalls++
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

/**
 * Ghi snapshot todo list (từ kết quả todo_write hoặc auto-todo của workflow).
 */
export function recordAgentRunTodos(
  sessionId: string | null | undefined,
  todos: AgentRunTodo[],
): void {
  try {
    const run = activeRun(sessionId)
    if (!run || !Array.isArray(todos) || todos.length === 0) return
    run.lastTodos = todos.slice(0, 50).map(t => ({
      id: String(t.id || ''),
      content: String(t.content || '').slice(0, 160),
      status: String(t.status || 'pending'),
      priority: t.priority ? String(t.priority) : undefined,
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
