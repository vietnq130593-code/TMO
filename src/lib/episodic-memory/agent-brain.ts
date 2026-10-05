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
}

const PREACT_TIMEOUT_MS = 4_000

/** Cache kết quả theo (family, task-hash) 60s — chống truy vấn lặp trong cùng workflow */
const BRAIN_CACHE_TTL_MS = 60_000
const globalForBrain = globalThis as unknown as {
  __tmoAgentBrainCache?: Map<string, AgentBrainBlock & { expiresAt: number }>
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
  const empty: AgentBrainBlock = { promptBlock: '', appliedLessonIds: [] }
  try {
    const task = params.task?.trim()
    if (!task) return empty

    // Cache check — cùng task trong 60s không truy vấn lại
    const cache = (globalForBrain.__tmoAgentBrainCache ??= new Map())
    const key = taskCacheKey(params.family, params.agentName, task)
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      return { promptBlock: cached.promptBlock, appliedLessonIds: cached.appliedLessonIds }
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
    }
    if (block.promptBlock === '' && block.appliedLessonIds.length === 0) return empty

    cache.set(key, { ...block, expiresAt: Date.now() + BRAIN_CACHE_TTL_MS })
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
 * Map trạng thái kết thúc của agent ngoài goal-loop → EpisodeOutcome thống
 * nhất (khớp semantics mapOutcome của recorder):
 *   - error/exception           → FAILURE
 *   - cancelled (user chủ động) → ABANDONED
 *   - done + không lỗi tool     → SUCCESS
 *   - done + có lỗi tool        → PARTIAL (giao được nhưng vướng)
 *   - hết vòng/iteration limit  → PARTIAL
 */
export function mapRunOutcome(params: {
  status: 'done' | 'error' | 'cancelled' | 'completed' | 'failed' | 'timeout' | 'iteration_limit'
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
  cycles?: number
  tokensUsed?: number
}): void {
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
        startedAt: new Date(Date.now() - 60_000), // ước lượng — caller gia đình ngoài không track chính xác
        endedAt: new Date(),
        toolEvidence: params.toolEvidence.slice(0, 60).map((ev, i) => ({
          cycle: typeof ev.cycle === 'number' ? ev.cycle : i + 1,
          tool: ev.tool,
          success: ev.success,
          text: ev.text,
        })),
        appliedLessonIds: params.appliedLessonIds ?? [],
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
