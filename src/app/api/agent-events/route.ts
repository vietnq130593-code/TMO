import { NextResponse } from 'next/server'
import { getRecentAgentEvents, getEventBusStats } from '@/lib/agent-event-bus'
import { listCacheStores } from '@/lib/cache-store'

/**
 * TASK 43 — AGENT EVENT LOOP OBSERVABILITY ENDPOINT
 * ===================================================
 * GET /api/agent-events
 *   ?limit=N     (default 100, max 300) — N sự kiện gần nhất của Agent Event Bus
 *   ?type=<t>    lọc theo loại sự kiện (run_started, tool_executed, job_terminal...)
 *
 * Response: { events, stats, caches, worker }
 *   - events : ring buffer sự kiện vòng đời agent (mới nhất cuối mảng)
 *   - stats  : bộ đếm theo loại sự kiện kể từ boot
 *   - caches : trạng thái toàn bộ CacheStore (TTL/hits/misses — Task 43
 *              Redis-ready abstraction)
 *   - worker : capacity info của GoalLoopWorker (adaptive concurrency)
 *
 * Never-500: mọi lỗi trả 200 với { error } — endpoint observability không
 * được phép tự gây sự cố.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const limitRaw = parseInt(url.searchParams.get('limit') ?? '100', 10)
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(300, limitRaw)) : 100
    const typeFilter = url.searchParams.get('type')

    const all = getRecentAgentEvents(limit)
    const events = typeFilter ? all.filter(e => e.type === typeFilter) : all

    // Worker capacity — import động (fail-open khi worker module lỗi).
    // Next dev: module load bởi instrumentation lúc boot giữ instance CŨ qua
    // hot-reload (globalThis singleton) — guard typeof để trả note thay vì null.
    let worker: Record<string, unknown> | null = null
    try {
      const { goalLoopWorker } = await import('@/lib/goal-loop-worker')
      worker = typeof goalLoopWorker.getCapacityInfo === 'function'
        ? goalLoopWorker.getCapacityInfo()
        : { note: 'worker instance chạy là bản build trước Task 43 — restart app để bật capacity info' }
    } catch (err) {
      console.error('[AgentEvents] goalLoopWorker import lỗi (fail-open):', err instanceof Error ? err.message : String(err))
      worker = null
    }

    return NextResponse.json({
      events,
      stats: getEventBusStats(),
      caches: listCacheStores(),
      worker,
    })
  } catch (err) {
    console.error('[AgentEvents] GET failed:', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ events: [], stats: null, caches: [], worker: null, error: 'agent-events query failed' })
  }
}
