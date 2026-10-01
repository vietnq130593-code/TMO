/**
 * AGENT EVENT BUS — event loop trung tâm của hệ multi-agent TMO
 * ==================================================================
 * (Task 43 — user audit "event loop / observability": trước đây các sự kiện
 * vòng đời agent rải rác theo từng console.log riêng lẽ, KHÔNG có nơi hợp
 * nhất để subscribe/quan sát. Đây là bus hợp nhất.)
 *
 * Thiết kế:
 *   - EventEmitter singleton trên globalThis (sống qua HMR reload của next dev)
 *   - Fail-open TUYỆT ĐỐI: emit lỗi KHÔNG BAO GIỜ làm hỏng caller (try/catch)
 *   - Ring buffer 300 event gần nhất (poll qua GET /api/agent-events)
 *   - KHÔNG đụng DB — bus là tầng observability thuần memory (bộ đếm sự kiện
 *     doanh nghiệp vẫn nằm ở ToolMetric / AgentRunRecord như cũ)
 *
 * Điểm phát sự kiện (các file emit):
 *   - agent-goal-loop.ts  : run_started / cycle_started / tool_executed /
 *                           delegation_completed / compression_applied /
 *                           escalation / run_terminal
 *   - goal-loop-worker.ts : job_enqueued / job_claimed / job_terminal /
 *                           queue_backpressure / capacity_changed
 *
 * Điểm tiêu thụ:
 *   - GET /api/agent-events (poll recent events + stats + cache stores)
 *   - subscribeAgentEvents() — cho module tương lai (SSE bridge, alerting...)
 */

import { EventEmitter } from 'node:events'

// ==================== TYPES ====================

export type AgentEventType =
  // Vòng đời goal-loop run (inline + durable)
  | 'run_started'
  | 'cycle_started'
  | 'tool_executed'
  | 'delegation_completed'
  | 'compression_applied'
  | 'escalation'
  | 'run_terminal'
  // Vòng đời durable job (worker)
  | 'job_enqueued'
  | 'job_claimed'
  | 'job_terminal'
  | 'job_heartbeat_stale'
  // Task C (round-7): job queued bị chờ mutex per-session quá lâu (head-of-line
  // blocking) — emit kèm blocker/follower trong payload để UI + ops theo dõi.
  | 'session_mutex_starvation'
  // Auto-scaling / backpressure
  | 'capacity_changed'
  | 'queue_backpressure'

export interface AgentEvent {
  type: AgentEventType
  at: string
  agentName?: string
  agentId?: string
  sessionId?: string | null
  runId?: string | null
  jobId?: string
  /** Payload tự do — mỗi loại sự kiện tự định nghĩa field (preview ngắn) */
  data?: Record<string, unknown>
}

// ==================== SINGLETON (globalThis — sống qua HMR) ====================

// ROUND-23 P4 — env-tunable (mặc định 300 như cũ): vặn nhỏ qua
// AGENT_EVENT_RING_MAX khi cần ép RSS mà không cần sửa code.
const RING_MAX = Math.max(50, Number(process.env.AGENT_EVENT_RING_MAX ?? 300) || 300)

interface BusState {
  bus: EventEmitter
  ring: AgentEvent[]
  counts: Record<string, number>
}

const globalForBus = globalThis as unknown as {
  __tmoAgentEventBus?: BusState
}

function getBusState(): BusState {
  if (!globalForBus.__tmoAgentEventBus) {
    const bus = new EventEmitter()
    bus.setMaxListeners(50) // nhiều subscriber quan sát — tránh MaxListeners warning
    globalForBus.__tmoAgentEventBus = { bus, ring: [], counts: {} }
  }
  return globalForBus.__tmoAgentEventBus
}

// ==================== EMIT / SUBSCRIBE ====================

/**
 * Phát 1 sự kiện lên bus + ghi vào ring buffer. FAIL-OPEN: mọi lỗi đều được
 * nuốt im lặng — observability KHÔNG BAO GIỜ làm hỏng vòng lặp agent.
 */
export function emitAgentEvent(
  type: AgentEventType,
  fields: Omit<AgentEvent, 'type' | 'at'> = {},
): void {
  try {
    const state = getBusState()
    const event: AgentEvent = { type, at: new Date().toISOString(), ...fields }
    state.ring.push(event)
    if (state.ring.length > RING_MAX) state.ring.splice(0, state.ring.length - RING_MAX)
    state.counts[type] = (state.counts[type] ?? 0) + 1
    // 'error' là event name đặc biệt của EventEmitter (throw nếu không có
    // listener) — TMO không dùng type này nên an toàn; vẫn bọc try/catch ngoài.
    state.bus.emit('agent-event', event)
    state.bus.emit(type, event) // channel theo loại cho subscriber chuyên biệt
  } catch {
    /* fail-open — event bus không được phép crash caller */
  }
}

/**
 * Subscribe MỌI sự kiện. Trả về hàm unsubscribe. Listener throw KHÔNG ảnh
 * hưởng caller (EventEmitter tự catch? KHÔNG — listener throw sẽ propagate;
 * wrapper dưới bọc try/catch từng listener call).
 */
export function subscribeAgentEvents(listener: (event: AgentEvent) => void): () => void {
  const state = getBusState()
  const wrapped = (event: AgentEvent) => {
    try {
      listener(event)
    } catch {
      /* fail-open — subscriber lỗi không làm hỏng bus */
    }
  }
  state.bus.on('agent-event', wrapped)
  return () => {
    try {
      state.bus.off('agent-event', wrapped)
    } catch { /* ignore */ }
  }
}

/** Subscribe 1 loại sự kiện duy nhất (channel chuyên biệt). */
export function subscribeAgentEventType(
  type: AgentEventType,
  listener: (event: AgentEvent) => void,
): () => void {
  const state = getBusState()
  const wrapped = (event: AgentEvent) => {
    try {
      listener(event)
    } catch { /* fail-open */ }
  }
  state.bus.on(type, wrapped)
  return () => {
    try {
      state.bus.off(type, wrapped)
    } catch { /* ignore */ }
  }
}

// ==================== QUERIES (cho /api/agent-events) ====================

/** N sự kiện gần nhất (mới nhất CUỐI mảng). */
export function getRecentAgentEvents(limit = 100): AgentEvent[] {
  const state = getBusState()
  const n = Math.max(1, Math.min(RING_MAX, limit))
  return state.ring.slice(-n)
}

/** Bộ đếm theo loại sự kiện kể từ boot process. */
export function getEventBusStats(): {
  totalEvents: number
  counts: Record<string, number>
  ringSize: number
  ringMax: number
  startedAt: string
} {
  const state = getBusState()
  const total = Object.values(state.counts).reduce((s, n) => s + n, 0)
  return {
    totalEvents: total,
    counts: { ...state.counts },
    ringSize: state.ring.length,
    ringMax: RING_MAX,
    startedAt: state.ring[0]?.at ?? new Date().toISOString(),
  }
}
