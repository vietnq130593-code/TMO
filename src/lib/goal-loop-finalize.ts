/**
 * CI-5 (GĐ4, Task 14-c) — FINALIZE GOAL LOOP RUN (đường durable)
 * ==============================================================
 *
 * GoalLoopWorker (src/lib/goal-loop-worker.ts) gọi `finalizeGoalLoopRun` QUA
 * SEAM fail-open (bước 10 executeJob) ngay sau khi mark job completed.
 * Module này thực hiện CHO ĐƯỜNG DURABLE những gì chat route
 * (src/app/api/openclaw/chat/route.ts) làm SAU runGoalDrivenLoop ở đường
 * inline cũ — để 2 đường (inline khi flag OFF / durable khi flag ON) có
 * CÙNG một nguồn sự thật cho từng bước:
 *
 *   1. Todo honest-close per-item CI-2  → helper `closeGoalLoopRunTodos`
 *      (route import lại — pure move từ khối inline cũ của route).
 *   2. WM HOT save assistant content    → mirror guard + isLlmErrorContent
 *      + slice(0,2500) của route (helper `isLlmErrorContent` move sang đây,
 *      route import lại).
 *   3. Assistant ChatMessage save       → mirror CHÍNH XÁC shape route lưu
 *      (content + metadata: confidence/reactIterations/toolCallsExecuted/
 *      agentRun/goalLoop/taskSummary) + link AgentRunRecord↔ChatMessage id
 *      (Task 20-c). agentRunSummary đọc từ in-memory tracker (getAgentRuns)
 *      — worker chạy cùng process nên đọc được run của runId. SAU RESTART-
 *      RESUME: in-memory registry trống → events chỉ còn đoạn resumed (chấp
 *      nhận theo thiết kế — metadata events là best-effort, không phải nguồn
 *      sự thật; AgentRunRecord DB vẫn đầy đủ do goal-loop caller-persist).
 *   4. KB Writeback (REVIEW 14-g H1)      → writebackToKBTransactionally +
 *      fallback autoLearnFromAnswer — mirror route L1116-1150. Thiếu bước
 *      này thì bật flag = app "ngừng học" Knowledge Base im lặng trên đường
 *      chat chính. kbSearchResult (KB pre-search) sống trong request scope
 *      đã kết thúc → dùng fallback shape rỗng (giống route khi
 *      kbSearchResult null).
 *   5. extractMemoriesFromConversation    → mirror route L1178-1186 (guard
 *      (REVIEW 14-g H1)                        isLlmErrorContent + isTrivialExchange).
 *   6. Periodic decay + HOT→WARM promote → mirror route L1188-1203; counter
 *      (REVIEW 14-g H1)                        module RIÊNG (route counter không
 *      share scope với worker) cùng ngưỡng 20.
 *   7. KHÔNG push realtime — frontend poll /api/goal-loop-jobs (Task 14-e).
 *
 * TUYÊN NGUYỆN FAIL-OPEN: mọi bước bọc try/catch riêng + log — finalize lỗi
 * KHÔNG BAO GIỜ làm job fail (job đã completed; worker còn 1 lớp try/catch
 * bọc ngoài seam như Belts & Suspenders).
 *
 * Roadmap: GĐ4 CI-5 B5 (Durable Goal Loop) — flag ENABLE_DURABLE_GOAL_LOOP.
 */

import type { GoalLoopJob } from '@prisma/client'
import type { GoalLoopResult } from '@/lib/agent-goal-loop'
import type { GoalLoopJobInput } from '@/lib/goal-loop-durable-types'
import { db } from '@/lib/db'
import { getAgentRuns } from '@/lib/agent-run-tracker'
import { closeRunTodosAtEnd } from '@/lib/code-team/dev-tools'
import { addToWorkingMemory } from '@/lib/memory-tiers'
import { saveChatMessages, extractMemoriesFromConversation, decayMemories } from '@/lib/agent-memory'
import { updateLatestAgentRunRecord } from '@/lib/metrics-db'
import { writebackToKBTransactionally } from '@/lib/kb-routing/transactional-writeback'
import { autoLearnFromAnswer, shouldAutoLearn } from '@/lib/auto-learn'

// ==================== SHARED HELPERS (route + finalize — 1 nguồn sự thật) ====================

/**
 * KIMI-ONLY: nội dung là LỖI LLM (key cạn/rate-limit/timeout...) — KHÔNG ghi
 * vào Knowledge Base (writeback) hay AgentMemory: chặn nhiễm dữ liệu garbage
 * vào graph/vectors từ error message. User vẫn thấy lỗi trong chat.
 *
 * PURE MOVE từ chat route (Task 14-c): route import lại từ đây để đường
 * durable + đường inline dùng cùng 1 định nghĩa "nội dung lỗi LLM".
 */
export function isLlmErrorContent(content: string): boolean {
  return typeof content === 'string' && content.startsWith('Error: Goal loop LLM failed')
}

/**
 * Check if a chat exchange is too trivial to warrant memory extraction.
 * Avoids wasting LLM tokens on greetings and short confirmations.
 *
 * PURE MOVE từ chat route (REVIEW 14-g H1): route import lại từ đây để đường
 * durable + đường inline dùng cùng 1 định nghĩa "exchange tầm thường" —
 * đồng bộ với pattern isLlmErrorContent (Task 14-c).
 */
export function isTrivialExchange(userMsg: string, assistantMsg: string): boolean {
  // Skip memory extraction for trivial exchanges (greetings, short confirmations)
  if (userMsg.trim().length < 15 && assistantMsg.trim().length < 50) return true
  const trivialPatterns = /^(hi|hello|hey|chào|xin chào|ok|okay|cảm ơn|thanks|thank you|bye|tạm biệt|được|vâng|yes|no|không)$/i
  if (trivialPatterns.test(userMsg.trim())) return true
  return false
}

/**
 * Todo honest-close per-item CI-2 — PURE MOVE từ khối inline của chat route
 * (sau runGoalDrivenLoop): todo của runId = result.runId được đóng theo trạng
 * thái thật của từng item:
 *   - in_progress → completed (mục tiêu đạt) | failed (chưa đạt — đã bắt tay
 *     làm mà dở)
 *   - pending (chưa từng bắt tay) → completed (đạt) | GIỮ pending + archivedAt
 *     (chưa đạt — không đổ lỗi failed, nhưng ẩn khỏi run sau)
 * Todo của CÁC run khác trong session KHÔNG bị đụng (đã archive khi run này
 * bắt đầu). Fail-open tuyệt đối — không bao giờ throw lên caller.
 */
export async function closeGoalLoopRunTodos(params: {
  sessionId?: string | null
  runId?: string | null
  goalLoop?: GoalLoopResult['goalLoop']
}): Promise<void> {
  const { sessionId, runId, goalLoop } = params
  if (!sessionId) return
  try {
    const goalIncomplete = goalLoop ? goalLoop.complete === false : false
    const closed = await closeRunTodosAtEnd({
      sessionId,
      runId: runId || null,
      goalComplete: !goalIncomplete,
    })
    const closedTotal = closed.inProgressClosed + closed.pendingCompleted + closed.pendingArchived
    if (closedTotal > 0) {
      console.log(`[Todo CI-2] Run ${runId || '(legacy)'} kết thúc (${goalIncomplete ? 'CHƯA đạt' : 'đạt'} mục tiêu): đóng ${closed.inProgressClosed} in_progress, ${closed.pendingCompleted} pending→completed, ${closed.pendingArchived} pending ẩn (archivedAt) trong session ${sessionId}`)
    }
  } catch { /* non-blocking — todo hiển thị chỉ là UI progress */ }
}

/**
 * Shape agentRunSummary persist vào ChatMessage.metadata.agentRun + trả trong
 * response JSON (frontend page.tsx đọc data.agentRun → agentRunSummary).
 */
export interface AgentRunMessageSummary {
  agentName: string
  status: string
  iterations: number
  toolCalls: number
  filesRead: number
  commandsRun: number
  editsMade: number
  durationMs?: number
  todos?: unknown
  /** Thought steps compact — persist qua restart (cap 80 events × 400 chars) */
  events: Array<{ type: string; ts: number; text: string }>
}

/**
 * Thought Process summary — PURE MOVE từ IIFE inline của chat route (sau
 * runGoalDrivenLoop): trích từ run tracker in-memory để (a) response JSON trả
 * về frontend, (b) persist vào chat message metadata cho session reload (hiện
 * lại panel tĩnh collapsed). Fail-open: tracker trống/throw → undefined
 * (metadata JSON.stringify bỏ key → panel tự ẩn).
 */
export function buildAgentRunSummaryForMessage(
  sessionId: string | null | undefined,
  runId: string | null | undefined,
): AgentRunMessageSummary | undefined {
  try {
    const run = sessionId && runId
      ? getAgentRuns(sessionId).find(r => r.runId === runId)
      : null
    if (!run) return undefined
    return {
      agentName: run.agentName,
      status: run.status,
      iterations: run.counters.iterations,
      toolCalls: run.counters.toolCalls,
      filesRead: run.counters.filesRead,
      commandsRun: run.counters.commandsRun,
      editsMade: run.counters.editsMade,
      durationMs: run.endedAt ? run.endedAt - run.startedAt : undefined,
      todos: run.lastTodos,
      events: run.events.slice(-80).map(e => ({
        type: e.type,
        ts: e.ts,
        text: typeof e.text === 'string' ? e.text.slice(0, 400) : '',
      })),
    }
  } catch { return undefined }
}

// ==================== FINALIZE (worker gọi sau job completed) ====================

/**
 * REVIEW 14-g H1 — periodic decay + HOT→WARM counter riêng cho đường durable
 * (counter của route sống ở module-scope route, không share với worker).
 * Cùng ngưỡng 20 như route: mỗi 20 finalize mới chạy 1 lần decay batch.
 */
let durableMemoryDecayCounter = 0

/**
 * Parse GoalLoopJobInput từ job.input JSON (fail-open → null khi hỏng/thiếu).
 */
function parseJobInput(job: GoalLoopJob): GoalLoopJobInput | null {
  if (typeof job.input !== 'string' || job.input.length === 0) return null
  try {
    const parsed = JSON.parse(job.input) as GoalLoopJobInput
    if (!parsed || typeof parsed !== 'object') return null
    return parsed
  } catch { return null }
}

/**
 * Finalize 1 goal-loop run đã completed — persist kết quả vào phiên chat gốc
 * (đối trọng đường inline của chat route). Từng BƯỚC fail-open riêng:
 * finalize lỗi KHÔNG làm job fail (job đã completed trong DB).
 *
 * @param args.job    — row GoalLoopJob MỚI NHẤT (status='completed', result đã ghi)
 * @param args.result — GoalLoopResult đã parse từ job.result
 */
export async function finalizeGoalLoopRun(args: { job: GoalLoopJob; result: GoalLoopResult }): Promise<void> {
  const { job, result } = args
  const sessionId = job.sessionId
  const content = result.content

  // jobInput mang agentProvider/agentModel (persist ChatMessage) + agentId
  // (= agentProfileId lúc enqueue — 'unknown' khi request thiếu profileId)
  const jobInput = parseJobInput(job)
  // Mirror guard route: `agentProfileId && sessionId` — enqueue ghi
  // agentId = agentProfileId || 'unknown' nên 'unknown' ≈ agentProfileId falsy
  // (chỉ ảnh hưởng request thủ công thiếu field — frontend thật luôn gửi).
  const agentProfileId = jobInput?.agentId && jobInput.agentId !== 'unknown' ? jobInput.agentId : null

  console.log(
    `[goal-loop-finalize] job ${job.id} (session ${sessionId}) — finalize bắt đầu: ` +
      `${result.iterations} vòng, ${result.toolCallsExecuted} tool calls, stopReason=${result.goalLoop?.stopReason ?? 'n/a'}, runId=${result.runId ?? 'n/a'}`
  )

  // ---- BƯỚC 1: Todo honest-close per-item CI-2 (helper chia sẻ với route) ----
  try {
    await closeGoalLoopRunTodos({ sessionId, runId: result.runId, goalLoop: result.goalLoop })
  } catch (todoErr) {
    console.warn(
      `[goal-loop-finalize] job ${job.id}: todo honest-close lỗi (fail-open — tiếp tục):`,
      todoErr instanceof Error ? todoErr.message : String(todoErr)
    )
  }

  // ---- BƯỚC 2: WORKING MEMORY (HOT) — mirror guard + isLlmErrorContent + slice(0,2500) ----
  try {
    if (agentProfileId && sessionId && content && !isLlmErrorContent(content)) {
      await addToWorkingMemory({
        agentId: agentProfileId,
        sessionId,
        content: content.slice(0, 2500),
        role: 'assistant',
      }).catch(() => { /* fail-open — route cũ cũng fire-and-forget */ })
    }
  } catch (wmErr) {
    console.warn(
      `[goal-loop-finalize] job ${job.id}: WM HOT save lỗi (fail-open — tiếp tục):`,
      wmErr instanceof Error ? wmErr.message : String(wmErr)
    )
  }

  // ---- BƯỚC 3: Assistant ChatMessage save — mirror CHÍNH XÁC shape route lưu ----
  // Guard mirror route (`agentProfileId && sessionId`, L~1078 cũ): request
  // thiếu agentProfileId → không persist assistant message (hành vi inline cũ
  // — 13-g finding #2); kết quả vẫn đọc được qua /api/goal-loop-jobs.
  try {
    if (agentProfileId && sessionId) {
      // agentRunSummary từ in-memory tracker — worker cùng process đọc được
      // run của runId. SAU RESTART-RESUME registry trống → events chỉ còn
      // đoạn resumed (chấp nhận — xem header module).
      const agentRunSummary = buildAgentRunSummaryForMessage(sessionId, result.runId)
      // Confidence THẬT: verdict trọng tài độc lập. (Divergence có chủ đích
      // so với route: route fallback thêm kbSearchResult?.confidence — KB
      // pre-search sống trong scope request đã kết thúc khi job chạy nền.)
      const finalConfidence = result.goalLoop?.evaluatorConfidence ?? undefined
      await saveChatMessages(sessionId, [
        {
          role: 'assistant',
          content,
          model: jobInput?.agentModel,
          provider: jobInput?.agentProvider,
          metadata: {
            confidence: finalConfidence,
            reactIterations: result.iterations,
            toolCallsExecuted: result.toolCallsExecuted,
            agentRun: agentRunSummary,
            goalLoop: result.goalLoop,
            taskSummary: result.taskSummary,
          },
        },
      ])
        .then(async () => {
          // Task 20-c — link AgentRunRecord của run này với ChatMessage id
          // vừa persist (message mới nhất của session). Mirror route: fire-
          // and-forget trong .then, fail-open — metrics không được phép làm
          // hỏng finalize.
          try {
            const latest = await db.chatMessage.findFirst({
              where: { sessionId, role: 'assistant' },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              select: { id: true },
            })
            if (latest) {
              await updateLatestAgentRunRecord(sessionId, { messageId: latest.id })
            }
          } catch { /* fail-open */ }
        })
        .catch(err => console.warn(
          '[goal-loop-finalize] Lưu ChatMessage assistant thất bại (job vẫn completed):',
          err instanceof Error ? err.message : String(err)
        ))
      console.log(
        `[goal-loop-finalize] job ${job.id}: đã lưu ChatMessage assistant vào session ${sessionId} (${content.length} chars, agentRunSummary ${agentRunSummary ? 'có' : 'không (tracker trống — resume?)'})`
      )
    }
  } catch (msgErr) {
    console.warn(
      `[goal-loop-finalize] job ${job.id}: ChatMessage save lỗi (fail-open — job vẫn completed):`,
      msgErr instanceof Error ? msgErr.message : String(msgErr)
    )
  }

  // ---- BƯỚC 4 (REVIEW 14-g H1): KB WRITEBACK — mirror route L1116-1150 ----
  // Smart KB Writeback: writebackToKBTransactionally (PendingWriteback saga)
  // + fallback autoLearnFromAnswer. Guard mirror route: hasAgent &&
  // !llmErrContent && !isTrivialExchange. step1Result fallback rỗng vì KB
  // pre-search (kbSearchResult) sống trong request scope đã kết thúc khi
  // worker chạy nền — giống nhánh route khi kbSearchResult null.
  try {
    const hasAgent = !!(agentProfileId && jobInput?.agentProvider && jobInput?.agentModel)
    const llmErrContent = isLlmErrorContent(content)
    const userMessage = jobInput?.userMessage ?? ''
    if (hasAgent && !llmErrContent && !isTrivialExchange(userMessage, content)) {
      writebackToKBTransactionally({
        query: userMessage,
        step2Result: { used: true, content, supplemented: true, source: 'model-knowledge' },
        step1Result: { chunks: [], entities: [], memories: [], communities: [], confidence: 0, source: 'user-kb' },
        agentId: agentProfileId!,
        agentName: jobInput?.agentName || 'unknown',
        sessionId,
      }).then(({ batchId, result }) => {
        console.log(`[Writeback][durable job ${job.id}] batchId=${batchId} entities=${result.entitiesWritten} rels=${result.relationshipsWritten} chunks=${result.chunksWritten} memory=${result.memoryStored}`)
      }).catch(err => {
        console.error('[Writeback][durable] Failed, falling back to autoLearn:', err instanceof Error ? err.message : String(err))
        // FIX (confidence giả 0.5/0.6): dùng confidence THẬT từ verdict trọng
        // tài của goal-loop (mirror BƯỚC 3) — trước đây hardcode 0.5/0.6 làm
        // AUTO_LEARN_MIN_CONFIDENCE cao hơn đường này im lặng ngừng học + record
        // audit sai confidence.
        const fallbackConfidence = result.goalLoop?.evaluatorConfidence ?? 0.6
        if (shouldAutoLearn(fallbackConfidence, hasAgent)) {
          autoLearnFromAnswer({
            query: userMessage,
            answer: content,
            confidence: fallbackConfidence,
            agentId: agentProfileId!,
            agentName: jobInput?.agentName || 'unknown',
            provider: jobInput!.agentProvider,
            model: jobInput!.agentModel,
            sources: [],
          }).catch(() => {})
        }
      })
    }
  } catch (kbErr) {
    console.warn(
      `[goal-loop-finalize] job ${job.id}: KB writeback lỗi (fail-open — tiếp tục):`,
      kbErr instanceof Error ? kbErr.message : String(kbErr)
    )
  }

  // ---- BƯỚC 5 (REVIEW 14-g H1): EXTRACT MEMORIES — mirror route L1178-1186 ----
  try {
    if (agentProfileId && !isLlmErrorContent(content) && jobInput?.userMessage && !isTrivialExchange(jobInput.userMessage, content)) {
      extractMemoriesFromConversation({
        agentId: agentProfileId,
        agentName: jobInput?.agentName || 'unknown',
        sessionId,
        userMessage: jobInput.userMessage,
        assistantMessage: content,
      }).catch(err => console.warn('[Memory][durable] Failed to extract memories:', err instanceof Error ? err.message : String(err)))
    }
  } catch (extractErr) {
    console.warn(
      `[goal-loop-finalize] job ${job.id}: memory extract lỗi (fail-open — tiếp tục):`,
      extractErr instanceof Error ? extractErr.message : String(extractErr)
    )
  }

  // ---- BƯỚC 6 (REVIEW 14-g H1): PERIODIC DECAY + HOT→WARM — mirror route L1188-1203 ----
  try {
    durableMemoryDecayCounter++
    if (durableMemoryDecayCounter >= 20 && agentProfileId) {
      durableMemoryDecayCounter = 0
      import('@/lib/memory-tiers')
        .then(m => m.promoteWorkingMemoryToWarm(agentProfileId))
        .catch(err => console.warn('[Memory][durable] HOT→WARM promotion error:', err instanceof Error ? err.message : String(err)))
      decayMemories(agentProfileId).catch(err =>
        console.warn('[Memory][durable] Periodic decay error:', err instanceof Error ? err.message : String(err))
      )
    }
  } catch { /* fail-open */ }

  // ---- KHÔNG BƯỚC 7: KHÔNG push realtime — frontend poll /api/goal-loop-jobs (14-e) ----
}
