// ============================================
// Session Resume — Phase 5.6 (spec Appendix C)
// ============================================
//
// Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md lines 723-779 (Appendix C)
//
// Persists the state of a long-running workflow session to SQLite so the
// agent can resume after a context-overflow pause. WorkflowSession.state
// stores a JSON-serialized { currentStep, todoIds, lastToolReceipts, ... }
// blob (SQLite has no native JSONB, so we use TEXT — Appendix C.1 line 741).
//
// CONCURRENT LOCK (Appendix C.3):
//   status='active' is the "lock held" marker. When 2 agents try to resume
//   the same session, the second gets 409 Conflict. A row whose updatedAt
//   is older than SESSION_LOCK_TIMEOUT_MS (30min) is treated as a stale lock
//   (the holder likely crashed) and can be acquired.
//
// FEATURE FLAG GATE:
//   Every public write operation (save/pause/resume/complete) is a no-op
//   when ENABLE_SESSION_RESUME is false. This lets the workflow-engine
//   import the module unconditionally without breaking when the flag is off.
//
// @module SessionResume

import { db } from '@/lib/db'
import { isFlagEnabled } from '@/lib/feature-flags'

// ============================================
// Types
// ============================================

/** Single tool receipt — appended to WorkflowState.lastToolReceipts. */
export interface ToolReceipt {
  tool: string
  args: Record<string, unknown>
  result: unknown
  timestamp: string
}

/** The serialized workflow state. Stored as JSON in WorkflowSession.state. */
export interface WorkflowState {
  /** Free-text label of where the workflow is — e.g. "G2-A code generation" */
  currentStep: string
  /** Todo item IDs (or full objects) tied to this session — used for resume re-injection */
  todoIds: string[] | unknown[]
  /** Last N tool receipts (newest at the end). Resume re-injects the last 5. */
  lastToolReceipts: ToolReceipt[]
  /** Free-form extension bag — workflow-engine.ts may stash extra fields here. */
  [key: string]: unknown
}

/** Result shape returned by saveWorkflowSession — null when flag disabled. */
export interface SaveSessionResult {
  id: string
  status: string
  contextOverflowCount: number
  updatedAt: Date
}

/** Result of resumeWorkflowSession — atomic check-and-acquire. */
export interface ResumeSessionResult {
  /** True when the caller successfully acquired the session (or it was already theirs). */
  ready: boolean
  /** The session row when ready=true; absent on conflict / not-found / flag-disabled. */
  session?: {
    id: string
    agentRole: string
    taskDescription: string
    state: string
    status: string
    contextOverflowCount: number
    createdAt: Date
    updatedAt: Date
  }
  /** True when another agent holds the lock (caller should 409). */
  conflict?: boolean
  /** True when the flag is disabled — caller should treat resume as a no-op. */
  flagDisabled?: boolean
}

/** Result of pauseWorkflowSession. */
export interface PauseSessionResult {
  success: boolean
  contextOverflowCount: number
}

/** Resume context payload (Appendix C.2 / C.4 line 773). */
export interface ResumeContext {
  taskDescription: string
  todoList: unknown[]
  lastToolReceipts: ToolReceipt[] // at most 5 most recent
  currentStep: string
}

// ============================================
// Constants
// ============================================

/** Appendix C.3 line 765: lock released after 30-min timeout. */
export const SESSION_LOCK_TIMEOUT_MS = 30 * 60 * 1000

/** Appendix C.4 line 773: re-inject "last 5 tool receipts". */
export const LAST_N_RECEIPTS = 5

/** Appendix C.5 line 777: >30 days completed → archived. */
const ARCHIVE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000

/** Appendix C.5 line 778: >7 days paused → alert. */
const PAUSE_ALERT_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000

/** Appendix C.5 line 779: max 100 active sessions per user (just warn in sandbox). */
const MAX_ACTIVE_SESSIONS = 100

// ============================================
// Serialization helpers
// ============================================

/**
 * Serialize a WorkflowState object to a JSON string for storage in
 * WorkflowSession.state (SQLite TEXT column, Appendix C.1).
 */
export function serializeWorkflowState(state: WorkflowState): string {
  return JSON.stringify(state)
}

/**
 * Deserialize a JSON string from WorkflowSession.state back into a typed
 * WorkflowState. Returns an empty stub on parse failure so callers don't
 * crash mid-resume.
 */
export function deserializeWorkflowState(json: string): WorkflowState {
  if (!json || typeof json !== 'string') {
    return { currentStep: '', todoIds: [], lastToolReceipts: [] }
  }
  try {
    const parsed = JSON.parse(json) as Partial<WorkflowState>
    return {
      currentStep: typeof parsed.currentStep === 'string' ? parsed.currentStep : '',
      todoIds: Array.isArray(parsed.todoIds) ? parsed.todoIds : [],
      lastToolReceipts: Array.isArray(parsed.lastToolReceipts) ? parsed.lastToolReceipts : [],
      ...parsed,
    }
  } catch (err) {
    console.warn('[SessionResume] deserializeWorkflowState: JSON.parse failed — returning empty stub. Error:', err instanceof Error ? err.message : String(err))
    return { currentStep: '', todoIds: [], lastToolReceipts: [] }
  }
}

// ============================================
// CRUD primitives — all gated behind ENABLE_SESSION_RESUME
// ============================================

/**
 * Save (upsert) a workflow session: create or update. Pass `state` as a
 * WorkflowState object — it's serialized before storage. Updated after
 * every tool call for incremental state (Appendix C.1 line 742).
 *
 * When ENABLE_SESSION_RESUME is false → no-op returning null.
 */
export async function saveWorkflowSession(
  sessionId: string,
  agentRole: string,
  taskDescription: string,
  state: WorkflowState,
  status: 'active' | 'paused' | 'completed' | 'failed' | 'archived' = 'active',
): Promise<SaveSessionResult | null> {
  if (!isFlagEnabled('ENABLE_SESSION_RESUME')) return null

  const stateJson = serializeWorkflowState(state)
  const existing = await db.workflowSession.findUnique({ where: { id: sessionId } })

  if (existing) {
    // Update — preserve contextOverflowCount unless caller explicitly bumps it.
    const updated = await db.workflowSession.update({
      where: { id: sessionId },
      data: {
        agentRole: agentRole || existing.agentRole,
        taskDescription: taskDescription || existing.taskDescription,
        state: stateJson,
        status,
      },
      select: { id: true, status: true, contextOverflowCount: true, updatedAt: true },
    })
    return updated
  }

  const created = await db.workflowSession.create({
    data: { id: sessionId, agentRole, taskDescription, state: stateJson, status },
    select: { id: true, status: true, contextOverflowCount: true, updatedAt: true },
  })
  return created
}

/**
 * Pause a workflow session (Appendix C.4 step 3): set status='paused' and
 * increment contextOverflowCount.
 *
 * When ENABLE_SESSION_RESUME is false → no-op returning success=false.
 */
export async function pauseWorkflowSession(
  sessionId: string,
  reason: string,
): Promise<PauseSessionResult> {
  if (!isFlagEnabled('ENABLE_SESSION_RESUME')) {
    return { success: false, contextOverflowCount: 0 }
  }

  try {
    // If the row doesn't exist (agent called pause before any save), create it
    // with status='paused' + contextOverflowCount=1 so the row exists for the
    // next agent to resume. Edge case documented Appendix C.4 step 2-3.
    const existing = await db.workflowSession.findUnique({ where: { id: sessionId } })
    if (!existing) {
      console.warn(`[SessionResume] pauseWorkflowSession: session ${sessionId} not found — creating a minimal paused row. Reason: ${reason}`)
      const created = await db.workflowSession.create({
        data: {
          id: sessionId,
          agentRole: 'UNKNOWN',
          taskDescription: `(paused before save — reason: ${reason})`,
          state: serializeWorkflowState({ currentStep: 'paused-pre-save', todoIds: [], lastToolReceipts: [] }),
          status: 'paused',
          contextOverflowCount: 1,
        },
        select: { contextOverflowCount: true },
      })
      return { success: true, contextOverflowCount: created.contextOverflowCount }
    }

    const updated = await db.workflowSession.update({
      where: { id: sessionId },
      data: {
        status: 'paused',
        contextOverflowCount: { increment: 1 },
      },
      select: { contextOverflowCount: true },
    })
    console.log(`[SessionResume] paused session ${sessionId} (count now ${updated.contextOverflowCount}). Reason: ${reason}`)
    return { success: true, contextOverflowCount: updated.contextOverflowCount }
  } catch (err) {
    console.error(`[SessionResume] pauseWorkflowSession failed for ${sessionId}:`, err instanceof Error ? err.message : String(err))
    return { success: false, contextOverflowCount: 0 }
  }
}

/**
 * Atomic check-and-resume (Appendix C.3):
 *
 *   status='active' + updatedAt < (now - 30min) → stale lock → resume (acquire)
 *   status='active' + recent                     → conflict (another agent holds it)
 *   status in {'paused','completed','failed'}    → resume (acquire)
 *   row not found                                 → ready=false, session=undefined
 *   flag disabled                                 → ready=false, flagDisabled=true
 *
 * Uses a Prisma transaction so the check+update is atomic against concurrent callers.
 */
export async function resumeWorkflowSession(sessionId: string): Promise<ResumeSessionResult> {
  if (!isFlagEnabled('ENABLE_SESSION_RESUME')) {
    return { ready: false, flagDisabled: true }
  }

  const THIRTY_MIN_AGO = new Date(Date.now() - SESSION_LOCK_TIMEOUT_MS)

  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.workflowSession.findUnique({ where: { id: sessionId } })
      if (!row) return { ready: false }

      const isActive = row.status === 'active'
      const lockStale = row.updatedAt.getTime() < THIRTY_MIN_AGO.getTime()

      if (isActive && !lockStale) {
        // Another agent holds the lock and updated it recently → conflict.
        return { ready: false, conflict: true }
      }

      // CI-3 B5 (Task 13-d) — STALE-LOCK RECOVERY LOG: lock_holder cũ còn giữ
      // status='active' nhưng updatedAt đã >30 phút (holder chắc chắn đã crash
      // hoặc treo) → chiếm lock lại (steal). Trước đây steal diễn ra NGẦM — giờ
      // log rõ để vận hành truy vết được lần chiếm lại.
      if (isActive && lockStale) {
        console.warn(`[SessionResume] stale lock detected on session ${sessionId}: holder kept status='active' but last update ${row.updatedAt.toISOString()} is older than ${SESSION_LOCK_TIMEOUT_MS / 60000}min — stealing the lock (holder likely crashed)`)
      }

      // Either:
      //   - status was 'paused' | 'completed' | 'failed' | 'archived' (free to acquire), OR
      //   - status was 'active' but stale (lock holder crashed >30min ago) → re-acquire.
      const updated = await tx.workflowSession.update({
        where: { id: sessionId },
        data: { status: 'active' }, // updatedAt auto-bumps via @updatedAt
        select: {
          id: true,
          agentRole: true,
          taskDescription: true,
          state: true,
          status: true,
          contextOverflowCount: true,
          createdAt: true,
          updatedAt: true,
        },
      })
      return { ready: true, session: updated }
    })
  } catch (err) {
    console.error(`[SessionResume] resumeWorkflowSession failed for ${sessionId}:`, err instanceof Error ? err.message : String(err))
    return { ready: false }
  }
}

/**
 * Mark a workflow session completed (Appendix C.3: "Lock released on completion").
 * Optionally stash the final serialized state.
 *
 * When ENABLE_SESSION_RESUME is false → no-op.
 */
export async function completeWorkflowSession(
  sessionId: string,
  finalState?: string,
): Promise<void> {
  if (!isFlagEnabled('ENABLE_SESSION_RESUME')) return

  try {
    const existing = await db.workflowSession.findUnique({ where: { id: sessionId } })
    if (!existing) {
      console.warn(`[SessionResume] completeWorkflowSession: session ${sessionId} not found — skipping.`)
      return
    }
    await db.workflowSession.update({
      where: { id: sessionId },
      data: {
        status: 'completed',
        ...(finalState !== undefined ? { state: finalState } : {}),
      },
    })
    console.log(`[SessionResume] completed session ${sessionId}`)
  } catch (err) {
    console.error(`[SessionResume] completeWorkflowSession failed for ${sessionId}:`, err instanceof Error ? err.message : String(err))
  }
}

// ============================================
// Pure helpers
// ============================================

/**
 * Pure helper — true when currentTokens exceeds the threshold (Appendix C.4 step 1).
 * Configurable threshold; the workflow-engine passes 80000 by default.
 */
export function detectContextOverflow(currentTokens: number, threshold: number): boolean {
  return typeof currentTokens === 'number' && typeof threshold === 'number' && currentTokens > threshold
}

/**
 * Rough token estimator: chars / 4 (Appendix C.4 step 1 + the spec hint about
 * "use a simple estimator: Math.ceil(JSON.stringify(messages).length / 4)").
 * Exported so workflow-engine.ts can call it on its messages array.
 *
 * Returns 0 for null/undefined/empty inputs so callers can short-circuit.
 */
export function estimateTokens(messages: unknown): number {
  if (messages === null || messages === undefined) return 0
  try {
    const s = JSON.stringify(messages)
    if (!s || s === 'null' || s === '[]' || s === '{}') return 0
    return Math.ceil(s.length / 4)
  } catch {
    return 0
  }
}

// ============================================
// Resume-context re-injection (Appendix C.4 step 5 + C.2)
// ============================================

/**
 * Build the resume context payload (Appendix C.2 / C.4 step 5):
 *   - taskDescription (original user request)
 *   - todoList (Todo rows scoped by sessionId)
 *   - lastToolReceipts (at most 5 most recent from serialized state)
 *   - currentStep (from serialized state)
 *
 * Reads WorkflowSession.state for currentStep + lastToolReceipts, and joins
 * the Todo table (Phase 1a.2 model) for the live todoList — todos may have
 * been updated since the session was paused, so we always pull fresh.
 *
 * When ENABLE_SESSION_RESUME is false → returns an empty stub.
 */
export async function buildResumeContext(sessionId: string): Promise<ResumeContext> {
  if (!isFlagEnabled('ENABLE_SESSION_RESUME')) {
    return { taskDescription: '', todoList: [], lastToolReceipts: [], currentStep: '' }
  }

  const row = await db.workflowSession.findUnique({ where: { id: sessionId } })
  if (!row) {
    return { taskDescription: '', todoList: [], lastToolReceipts: [], currentStep: '' }
  }

  // Pull live todos scoped by sessionId (Phase 1a.2 Todo model — see schema)
  // Resilient to the Todo table not existing (early-dev DBs may not have it).
  let todoList: unknown[] = []
  try {
    todoList = await db.todo.findMany({
      where: { sessionId },
      orderBy: { position: 'asc' },
      take: 200,
    })
  } catch (err) {
    console.warn('[SessionResume] buildResumeContext: Todo table unavailable — returning empty todoList.', err instanceof Error ? err.message : String(err))
  }

  const state = deserializeWorkflowState(row.state)
  const receipts = Array.isArray(state.lastToolReceipts) ? state.lastToolReceipts : []
  // Appendix C.4 line 773: re-inject "last 5 tool receipts" — newest at the end.
  const lastFive = receipts.slice(-LAST_N_RECEIPTS)

  return {
    taskDescription: row.taskDescription,
    todoList,
    lastToolReceipts: lastFive,
    currentStep: state.currentStep || row.taskDescription,
  }
}

// ============================================
// CI-3 B5 (Task 13-d) — Shared resume entry point
// ============================================

/**
 * Shared resume logic used by BOTH the POST /api/workflow/resume route AND
 * the workflow-engine in-process auto-resume (GĐ3 B5: "resume tự động, không
 * cần API thủ công"). Reuses the exact same code path:
 *   1. resumeWorkflowSession — atomic check-and-acquire (stale-lock 30-min
      recovery included) — the core of the resume endpoint.
 *   2. buildResumeContext — Appendix C.2 payload (task + todos + last 5
 *      tool receipts + currentStep) for whoever continues the session.
 *
 * Fail-open semantics: buildResumeContext failing does NOT undo the acquired
 * lock — the session stays 'active' and the (already fail-open) empty context
 * is returned instead. Callers must NEVER crash on this result.
 */
export interface PerformSessionResumeResult extends ResumeSessionResult {
  /** Present only when ready=true. Empty stub when the context build failed. */
  context?: ResumeContext
}

export async function performSessionResume(sessionId: string): Promise<PerformSessionResumeResult> {
  const resumeResult = await resumeWorkflowSession(sessionId)
  if (!resumeResult.ready || !resumeResult.session) {
    // flagDisabled / conflict / not-found / DB error — pass through untouched.
    return resumeResult
  }
  try {
    const context = await buildResumeContext(sessionId)
    return { ...resumeResult, context }
  } catch (err) {
    // Lock đã acquire xong — context build fail KHÔNG được làm hỏng resume.
    console.error(`[SessionResume] performSessionResume: buildResumeContext failed for ${sessionId} (lock vẫn giữ nguyên):`, err instanceof Error ? err.message : String(err))
    return resumeResult
  }
}

// ============================================
// Cleanup (Appendix C.5)
// ============================================

/**
 * Cleanup job (Appendix C.5):
 *   - Sessions >30 days with status='completed' → mark status='archived'
 *     (no real cold storage in sandbox — spec line 777 says "just soft-delete").
 *   - Sessions with status='paused' >7 days → console.warn (alert user).
 *   - More than 100 active sessions → console.warn (no FIFO eviction in sandbox).
 *
 * Returns the count of rows archived. Safe to call periodically from a cron
 * or on workflow start.
 */
export async function archiveOldSessions(): Promise<{ archived: number }> {
  if (!isFlagEnabled('ENABLE_SESSION_RESUME')) {
    return { archived: 0 }
  }

  let archived = 0
  const thirtyDaysAgo = new Date(Date.now() - ARCHIVE_THRESHOLD_MS)
  const sevenDaysAgo = new Date(Date.now() - PAUSE_ALERT_THRESHOLD_MS)

  try {
    // 1. Archive >30-day completed sessions (Appendix C.5 line 777).
    const stale = await db.workflowSession.findMany({
      where: { status: 'completed', updatedAt: { lt: thirtyDaysAgo } },
      select: { id: true },
    })
    if (stale.length > 0) {
      const result = await db.workflowSession.updateMany({
        where: { id: { in: stale.map((r) => r.id) } },
        data: { status: 'archived' },
      })
      archived = result.count
      console.log(`[SessionResume] archived ${archived} stale completed sessions (>30 days).`)
    }

    // 2. Alert >7-day paused sessions (Appendix C.5 line 778).
    const pausedStale = await db.workflowSession.findMany({
      where: { status: 'paused', updatedAt: { lt: sevenDaysAgo } },
      select: { id: true, taskDescription: true, updatedAt: true },
    })
    for (const p of pausedStale) {
      console.warn(`[SessionResume] paused session ${p.id} (${p.taskDescription.slice(0, 60)}) stale since ${p.updatedAt.toISOString()} (>7 days). Prompt user to resume or delete.`)
    }

    // 3. Warn if >100 active sessions (Appendix C.5 line 779 — no FIFO eviction in sandbox).
    const activeCount = await db.workflowSession.count({ where: { status: 'active' } })
    if (activeCount > MAX_ACTIVE_SESSIONS) {
      console.warn(`[SessionResume] ${activeCount} active sessions exceed the ${MAX_ACTIVE_SESSIONS}-session cap — FIFO eviction is not implemented in sandbox (Appendix C.5).`)
    }
  } catch (err) {
    console.error('[SessionResume] archiveOldSessions failed:', err instanceof Error ? err.message : String(err))
  }

  return { archived }
}

/**
 * Lightweight session metadata getter for the GET /api/workflow/resume endpoint.
 * Deliberately omits `state` (could be large — Appendix C.2 doesn't require it).
 */
export async function getSessionMetadata(
  sessionId: string,
): Promise<{
  id: string
  agentRole: string
  taskDescription: string
  status: string
  contextOverflowCount: number
  createdAt: Date
  updatedAt: Date
} | null> {
  if (!isFlagEnabled('ENABLE_SESSION_RESUME')) return null

  const row = await db.workflowSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      agentRole: true,
      taskDescription: true,
      status: true,
      contextOverflowCount: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  return row
}
