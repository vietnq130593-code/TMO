/**
 * AGENT BRAIN ADAPTER — Round-37 V3
 * ==================================
 * Rà soát lượt 3 (round-36): chỉ gia đình goal-loop nối vào bộ não episodic
 * (preact→inject→arbiter→record); 4 gia đình còn lại — code-team,
 * research-team, sub-agents (delegation), opencode-route — KHÔNG có preact
 * (không bao giờ được nhắc bài học cũ) và KHÔNG record episode (lỗi của
 * chúng không bao giờ thành bài học). Module này là adapter dùng chung:
 *
 *   buildAgentBrainBlock()  — PRE-ACT cho gia đình ngoài goal-loop:
 *                             truy vấn lesson/episode tương tự → prompt block
 *   recordAgentEpisode()    — CONSOLIDATE cho gia đình ngoài goal-loop:
 *                             wrap recordEpisodeFromRun (fire-and-forget)
 *   mapRunOutcome()         — map (status, toolFailures, endedBy) →
 *                             EpisodeOutcome thống nhất 4 gia đình
 *
 * Fail-open tuyệt đối: bộ não chết → trả rỗng / không record — KHÔNG BAO GIỜ
 * làm hỏng agent chính. Timeout guard bên trong (Promise.race) — PRE-ACT
 * thêm ≤4s cold-start.
 */

import type { EpisodeOutcome } from './types'

// ==================== PRE-ACT (CHO GIA ĐÌNH NGOÀI GOAL-LOOP) ====================

/** Kết quả buildAgentBrainBlock — mirror shape goal-loop dùng */
export interface AgentBrainBlock {
  /** Append vào system prompt ('' khi bộ nhớ trống) */
  promptBlock: string
  /** Lesson được tính "applied" — validate sau run khi có outcome */
  appliedLessonIds: string[]
  /** ROUND-39 — subset exploration (ε-greedy) của appliedLessonIds — được
   *  chấm ±confidence NHỎ khi outcome PARTIAL có dấu vết lỗi tool. */
  explorationLessonIds: string[]
}

const PREACT_TIMEOUT_MS = 4_000

/** Cache kết quả theo (family, task-hash) 60s — chống truy vấn lặp trong cùng workflow */
const BRAIN_CACHE_TTL_MS = 60_000
/** ROUND-38 fix Y2 — TTL ngắn cho kết quả RỖNG: memory trống không được đục
 * cache lâu (bài học vừa học 5s trước nên hiện ra ở PRE-ACT lần chạy kế),
 * nhưng vẫn chống đấm Qdrant+Neo4j mỗi step khi kho thật sự trống. */
const BRAIN_CACHE_EMPTY_TTL_MS = 15_000
const globalForBrain = globalThis as unknown as {
  __tmoAgentBrainCache?: Map<string, AgentBrainBlock & { expiresAt: number; family?: string; agentName?: string }>
}

function taskCacheKey(family: string, agentName: string, task: string): string {
  // Hash đơn giản — đủ cho cache key
  let h = 0
  const s = `${family}|${agentName}|${task.slice(0, 200)}`
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `k${h}`
}

/**
 * PRE-ACT cho agent gia đình ngoài goal-loop (code-team step, research round,
 * delegation sub-agent, opencode session).
 *
 * @param params.family   — 'code-team' | 'research-team' | 'sub-agent' | 'opencode'
 * @param params.agentName — tên agent hiển thị trong episode (VD 'MEGATRON (G2-A)')
 * @param params.task     — mô tả task sắp chạy (query episodic memory với text này)
 */
export async function buildAgentBrainBlock(params: {
  family: 'code-team' | 'research-team' | 'sub-agent' | 'opencode'
  agentName: string
  task: string
}): Promise<AgentBrainBlock> {
  const empty: AgentBrainBlock = { promptBlock: '', appliedLessonIds: [], explorationLessonIds: [] }
  try {
    const task = params.task?.trim()
    if (!task) return empty

    // Cache check — cùng task trong 60s không truy vấn lại
    const cache = (globalForBrain.__tmoAgentBrainCache ??= new Map())
    const key = taskCacheKey(params.family, params.agentName, task)
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return { promptBlock: cached.promptBlock, appliedLessonIds: cached.appliedLessonIds, explorationLessonIds: cached.explorationLessonIds ?? [] }
    }
    // Timeout guard — PRE-ACT không được làm chậm agent chính
    const { buildPreActContext } = await import('./preact')
    let timer: ReturnType<typeof setTimeout> | undefined
    const preact = await Promise.race([
      buildPreActContext({ agentName: `${params.family}/${params.agentName}`, task }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), PREACT_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer)
    })
    if (!preact) return empty

    const block: AgentBrainBlock = {
      promptBlock: preact.promptBlock || '',
      appliedLessonIds: preact.appliedLessonIds ?? [],
      explorationLessonIds: preact.explorationLessonIds ?? [],
    }
    if (block.promptBlock === '' && block.appliedLessonIds.length === 0) {
      // ROUND-38 fix Y2: cache cả kết quả RỖNG với TTL ngắn (15s) — trước đây
      // empty luôn re-query Qdrant+Neo4j MỖI step (mâu thuẫn mục đích cache);
      // nhưng TTL ngắn để lesson vừa học xuất hiện ở lần retry kế.
      cache.set(key, { ...empty, expiresAt: Date.now() + BRAIN_CACHE_EMPTY_TTL_MS, family: params.family, agentName: params.agentName })
      return empty
    }

    cache.set(key, { ...block, expiresAt: Date.now() + BRAIN_CACHE_TTL_MS, family: params.family, agentName: params.agentName })
    // Cap cache 100 entry FIFO
    while (cache.size > 100) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
    }
    return block
  } catch (err) {
    console.warn(
      `[AgentBrain] buildAgentBrainBlock failed (fail-open — ${params.family}/${params.agentName}):`,
      err instanceof Error ? err.message : String(err),
    )
    return empty
  }
}

// ==================== OUTCOME MAPPING ====================

/**
 * ROUND-38 fix B2 — parse 1 entry toolResultLog (JSON string {tool, success,
 * result}) thành evidence. Trước đây nằm inline ở subagent-delegate với
 * `String(parsed.result)` — object (file_read {content,totalLines}, file_edit
 * lỗi {error}) → '[object Object]' → taxonomy classify nhầm + lesson rác.
 * Extract lên đây (dùng chung + probe/test gọi được trực tiếp): string giữ
 * nguyên, object JSON.stringify, cắt 600 chars.
 */
export function parseToolResultLogEntry(entry: string): { tool: string; success: boolean; text: string } {
  try {
    const parsed = JSON.parse(entry) as { tool?: unknown; success?: unknown; result?: unknown }
    const rawResult = parsed.result ?? entry
    const text = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult)
    return {
      tool: typeof parsed.tool === 'string' ? parsed.tool : 'unknown',
      success: parsed.success === true,
      text: (text ?? '').slice(0, 600),
    }
  } catch {
    return { tool: 'unknown', success: false, text: entry.slice(0, 600) }
  }
}

/**
 * Map trạng thái kết thúc của agent ngoài goal-loop → EpisodeOutcome thống
 * nhất (khớp semantics mapOutcome của recorder):
 *   - error/exception           → FAILURE
 *   - cancelled (user chủ động) → ABANDONED
 *   - done + không lỗi tool     → SUCCESS
 *   - done + có lỗi tool        → PARTIAL (giao được nhưng vướng)
 *   - hết vòng/iteration limit  → PARTIAL
 */
export function mapRunOutcome(params: {
  status: 'done' | 'error' | 'cancelled' | 'completed' | 'failed' | 'timeout' | 'iteration_limit' | 'stall_brake' | 'no_progress'
  toolFailures: number
}): EpisodeOutcome {
  switch (params.status) {
    case 'error':
    case 'failed':
      return 'FAILURE'
    case 'cancelled':
      return 'ABANDONED'
    case 'timeout':
    case 'iteration_limit':
    // r60 (A3) — stall_brake/no_progress: phanh cắt bế tắc (model có kết quả
    // trong tay, chỉ quay vòng) — cùng lớp "giao được một phần" với iteration_limit
    case 'stall_brake':
    case 'no_progress':
      return 'PARTIAL'
    case 'done':
    case 'completed':
      return params.toolFailures > 0 ? 'PARTIAL' : 'SUCCESS'
    default:
      return 'PARTIAL'
  }
}

// ==================== CONSOLIDATE (RECORD EPISODE) ====================

/**
 * CONSOLIDATE cho agent gia đình ngoài goal-loop — fire-and-forget wrap của
 * recordEpisodeFromRun. KHÔNG await-được lỗi (mọi thứ .catch im lặng —
 * ghi não không được phép làm hỏng response agent).
 *
 * @param params.toolEvidence — các tool call [{tool, success, text}] (text =
 *        input/result hoặc message lỗi — recorder tự classify root cause)
 */
export function recordAgentEpisode(params: {
  family: 'code-team' | 'research-team' | 'sub-agent' | 'opencode'
  agentName: string
  goal: string
  sessionId?: string | null
  outcome: EpisodeOutcome
  stopReason: string
  toolEvidence: Array<{ tool: string; success: boolean; text: string; cycle?: number }>
  appliedLessonIds?: string[]
  /** ROUND-39 — subset exploration (ε-greedy) của appliedLessonIds — recorder
   *  dùng để chấm ±confidence NHỎ cho đúng lesson khi outcome PARTIAL. */
  explorationLessonIds?: string[]
  cycles?: number
  tokensUsed?: number
  /** ROUND-38 fix Y3 — thời điểm bắt đầu THẬT của run (ms epoch hoặc Date).
  * Trước đây mọi gia đình ghi duration ảo 60s → metrics thời lượng học bóp méo.
  * Mặc định: now−60s (giữ hành vi cũ cho caller chưa truyền). */
  startedAt?: number | Date
}): void {
  // ━━ ROUND-38 fix Y2 — invalidate brain cache của (family, agentName) — trước
  // đây record xong episode mà cache PRE-ACT 60s vẫn trả bộ não CŨ (không có
  // bài học vừa ghi) cho chính agent retry lại task y hệt — pattern retry bị
  // phục vụ stale brain. Cache ≤100 entry nên quét hết rẻ.
  try {
    const cache = globalForBrain.__tmoAgentBrainCache
    if (cache && cache.size > 0) {
      for (const [k, v] of cache) {
        if (v.family === params.family && v.agentName === params.agentName) cache.delete(k)
      }
    }
  } catch { /* fail-open */ }
  void (async () => {
    try {
      const { recordEpisodeFromRun } = await import('./recorder')
      const result = await recordEpisodeFromRun({
        agentName: `${params.family}/${params.agentName}`,
        goal: params.goal,
        sessionId: params.sessionId ?? null,
        outcome: params.outcome,
        confidence: params.outcome === 'SUCCESS' ? 0.8 : params.outcome === 'FAILURE' ? 0.6 : 0.7,
        stopReason: params.stopReason,
        cycles: params.cycles ?? 1,
        tokensUsed: params.tokensUsed ?? 0,
        toolCalls: params.toolEvidence.length,
        startedAt: params.startedAt !== undefined
          ? new Date(params.startedAt)
          : new Date(Date.now() - 60_000), // fallback ước lượng — caller nên truyền startedAt thật (fix Y3)
        endedAt: new Date(),
        toolEvidence: params.toolEvidence.slice(0, 60).map((ev, i) => ({
          cycle: typeof ev.cycle === 'number' ? ev.cycle : i + 1,
          tool: ev.tool,
          success: ev.success,
          text: ev.text,
        })),
        appliedLessonIds: params.appliedLessonIds ?? [],
        explorationLessonIds: params.explorationLessonIds ?? [],
      })
      if (result.episodeId) {
        console.log(
          `[AgentBrain] ${params.family}/${params.agentName} — episode ${result.episodeId} (${params.outcome}, ${result.errorsRecorded} errors, ${result.lessonsCreated} lesson mới, ${result.lessonsMerged} merge, validate ${result.lessonsValidated}✓/${result.lessonsFailed}✗)`,
        )
      } else if (result.error) {
        console.warn(`[AgentBrain] ${params.family}/${params.agentName} — record lỗi: ${result.error}`)
      }
    } catch (err) {
      console.warn(
        `[AgentBrain] recordAgentEpisode failed (fail-open — ${params.family}/${params.agentName}):`,
        err instanceof Error ? err.message : String(err),
      )
    }
  })()
}
