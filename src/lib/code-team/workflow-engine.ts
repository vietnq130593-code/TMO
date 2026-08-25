/**
 * Code Team — Workflow Engine (Core Orchestration)
 *
 * Implements the pipeline orchestration from workflow doc:
 *   - TL analyzes request → Routing Decision (mode A/B/C + tier 1/2/3)
 *   - Pipeline runs sequentially: TL → [G1 →] [G2-A →] G2-B [→ G3] → TL verify
 *   - Each agent step uses ReAct loop for tool calls
 *   - TL checkpoint verify after each group: CONTINUE / PIVOT / ESCALATE
 *
 * Architecture:
 *   runWorkflow(request, emit)
 *     → Step 1: TL analyzes routing
 *     → Step 2: Run pipeline based on routing
 *       → For each step: runAgentStep() with ReAct loop
 *       → After checkpoint: runTLCheckpointVerify()
 *     → Workflow done
 *
 * SSE events are emitted to client for real-time rendering.
 */

import { callLLMForAgent, type LLMResult, type LLMTool } from '@/lib/llm'
import { db } from '@/lib/db'
import { getAgentTools } from './agents'
import { getAgentPrompt, buildToolSchemasSection } from './prompts'
import { getToolDefinitionsForPosition } from './tool-executor'
import {
  resolveAgent,
  resolveAllAgents,
  getResolutionSummary,
  type ResolvedAgent,
} from './agent-resolver'
import {
  writeWorklog,
  readWorklog,
  buildContextForAgent,
  parseWorklogFromOutput,
  verifyWorklog,
  upsertSession,
  completeSession,
  type WorklogEntry,
  type RoutingDecision,
  findBalancedJson as findBalancedJsonUtil,
} from './worklog'
import {
  executeTool,
} from './tool-executor'
import { flagMode, isFlagEnabled } from '@/lib/feature-flags'
// Phase 6/7 (rebuild) — workspace root follows the USER's ACTIVE workspace
import { resolveWorkspaceRoot } from './workspace-root'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
// Phase 3 audit fix (Task 9): execFileAsync passes argv as array — bypasses
// shell entirely. Used by Phase 4.3 (staging branch) git commands to avoid
// shell interpolation of user-controlled sessionId values.
const execFileAsync = promisify(execFile)

// ==================== v2.1 Phase 4 — Process, Safety, Plan Mode, Cron ====================
//
// Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 4 (lines 245-281)
//
// 4.1 — Auto-checkpoint before risky ops (file_edit/file_delete/file_multi_edit/git_commit/run_tests)
// 4.2 — Auto-restore on verify failure (TL checkpoint verify returns PIVOT/ESCALATE)
// 4.3 — Staging branch per workflow (code-team/<sessionId>) — all edits target this branch
//
// All three behaviors are feature-flagged so operators can flip them off without
// code changes. See feature-flags.ts Phase 4 block.

import {
  autoCheckpointBeforeRiskyOp,
  autoRestoreOnVerifyFailure,
} from '@/lib/workspace/neo4j-checkpoint'
import { getFsCheckpoint, autoRestoreFsOnVerifyFailure } from '@/lib/workspace/fs-checkpoint'
// v2.1 Phase 5.6 — Session Resume (spec Appendix C, lines 723-779)
// Detection + pause + state serialization; the actual resume is a manual API call
// to POST /api/workflow/resume?sessionId=X. Feature-flagged so the import is safe
// when ENABLE_SESSION_RESUME is off (every public fn returns a no-op).
import {
  detectContextOverflow,
  estimateTokens,
  pauseWorkflowSession,
  saveWorkflowSession,
  type WorkflowState,
} from '@/lib/orchestration/session-resume'
// Phase 2 SMOLAB Proposal 7 — Layer 9 MetricsCollector.
// Production code path (runWorkflow) hooks Layer 9 so ExecutionMetrics
// actually persists to SQLite. Before this, master-orchestrator had Layer 9
// wired but only runs when ENABLE_MASTER_ORCHESTRATOR=true (currently false)
// → metrics were "phantom wired": code called db.executionMetrics.create()
// (added in Phase 6 Prop 2) but the production path never invoked it.
// Fire-and-forget pattern: any flush error is caught + logged, never
// crashes the workflow (metrics are best-effort side-effects).
import { createMetricsCollector, type MetricsCollector } from '@/lib/learning'

/** Operations that trigger auto-checkpoint BEFORE they execute. */
const RISKY_OPS = new Set<string>([
  'file_edit', 'file_delete', 'file_multi_edit', 'git_commit', 'run_tests',
])

/**
 * Phase 4.3 — Create a git staging branch `code-team/<sessionId>` from the
 * current HEAD before the workflow starts. All file_edit/git_commit ops during
 * the workflow target this branch (not main). Gated by ENABLE_STAGING_BRANCH.
 *
 * Strategy:
 *   1. Check `git status --porcelain` — if uncommitted changes, warn + skip
 *      (we never disrupt the user's working tree).
 *   2. Capture current branch (default = main). NEVER operate on a detached HEAD.
 *   3. `git checkout -b code-team/<sessionId>` — fails silently if branch exists.
 *
 * Implementation: uses execFileAsync to avoid shell interpolation of the
 * sessionId (Phase 3 audit fix Task 9 — never shell-interpolate user input).
 *
 * Returns the staging branch name on success, null on failure/skip.
 */
async function createStagingBranch(sessionId: string): Promise<string | null> {
  if (!isFlagEnabled('ENABLE_STAGING_BRANCH')) return null

  const workspaceRoot = await resolveWorkspaceRoot()
  const branchName = `code-team/${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60)}`

  try {
    // 1. Check git state — refuse if working tree is dirty
    const statusResult = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: workspaceRoot,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    })
    if (statusResult.stdout.trim() !== '') {
      console.warn(`[Workflow] Staging branch skipped — working tree has uncommitted changes (git status --porcelain returned ${statusResult.stdout.trim().split('\n').length} line(s))`)
      return null
    }

    // 2. Check if branch already exists — if so, check it out (idempotent re-run)
    const branchCheck = await execFileAsync('git', ['branch', '--list', branchName], {
      cwd: workspaceRoot,
      timeout: 10_000,
    })
    if (branchCheck.stdout.trim() !== '') {
      // Branch exists — just check it out
      await execFileAsync('git', ['checkout', branchName], {
        cwd: workspaceRoot,
        timeout: 10_000,
      })
      console.log(`[Workflow] Staging branch reused: ${branchName} (already existed, checked out)`)
      return branchName
    }

    // 3. Create + checkout the new branch
    await execFileAsync('git', ['checkout', '-b', branchName], {
      cwd: workspaceRoot,
      timeout: 10_000,
    })
    console.log(`[Workflow] Staging branch created: ${branchName}`)
    return branchName
  } catch (err) {
    console.warn(
      `[Workflow] Staging branch setup failed (non-blocking): ${err instanceof Error ? err.message : String(err)} — workflow proceeds on current branch`,
    )
    return null
  }
}

/**
 * Phase 4.3 — Merge the staging branch back to its parent branch (typically main).
 * Called at workflow end. Skipped if ENABLE_STAGING_BRANCH is off OR if the
 * staging branch was never created (e.g. dirty working tree prevented creation).
 *
 * Strategy: `git checkout main && git merge --no-ff code-team/<sessionId>`
 * On merge conflict: log + leave the staging branch for manual resolution.
 */
async function mergeStagingBranch(stagingBranch: string | null, sessionId: string): Promise<void> {
  if (!isFlagEnabled('ENABLE_STAGING_BRANCH') || !stagingBranch) return

  const workspaceRoot = await resolveWorkspaceRoot()

  try {
    // Capture the parent branch (the branch we were on before staging).
    // We assume 'main' as the parent — this is configurable via env if needed.
    const parentBranch = process.env.STAGING_PARENT_BRANCH || 'main'

    // Check out parent + merge staging
    try {
      await execFileAsync('git', ['checkout', parentBranch], {
        cwd: workspaceRoot,
        timeout: 10_000,
      })
    } catch (err) {
      console.warn(`[Workflow] Could not checkout parent ${parentBranch}: ${err instanceof Error ? err.message : String(err)} — leaving staging branch ${stagingBranch} for manual merge`)
      return
    }

    // Merge with --no-ff so we always get a merge commit (preserves staging lineage)
    await execFileAsync('git', ['merge', '--no-ff', '-m', `Merge staging branch ${stagingBranch} (session ${sessionId})`, stagingBranch], {
      cwd: workspaceRoot,
      timeout: 30_000,
    })
    console.log(`[Workflow] Staging branch ${stagingBranch} merged into ${parentBranch}`)
  } catch (err) {
    console.warn(
      `[Workflow] Staging branch merge FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)} — leaving ${stagingBranch} for manual resolution`,
    )
  }
}

/**
 * Phase 4.3 — Get workspace root for fs-checkpoint.
 * Phase 6/7 (rebuild) — now async + resolves the USER's ACTIVE workspace
 * (WorkspaceManager → SQLite) via workspace-root.ts, with a 5s cache.
 */
async function getWorkspaceRoot(): Promise<string> {
  return resolveWorkspaceRoot()
}


// ==================== v2.1 Phase 1a.3: QUALITY GATE ====================
//
// Enforced before workflow_done emit. Runs `bun run lint` + `tsc --noEmit`,
// parses errors, and emits 'completed_with_errors' status if errors found
// in strict mode. In 'warn' mode, workflow still 'completed' but with
// warning payload.
//
// Feature flag: ENABLE_QUALITY_GATE (off | warn | strict), default 'off'
// See: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 4 Phase 1a.3
//
interface QualityReport {
  mode: 'off' | 'warn' | 'strict'
  lintErrors: number
  tscErrors: number
  lintSample?: string[]
  tscSample?: string[]
  durationMs: number
}

async function enforceQualityGate(): Promise<QualityReport> {
  const mode = flagMode('ENABLE_QUALITY_GATE', ['off', 'warn', 'strict']) as 'off' | 'warn' | 'strict'
  const startedAt = Date.now()

  if (mode === 'off') {
    return { mode, lintErrors: 0, tscErrors: 0, durationMs: 0 }
  }

  // Run lint + tsc in parallel (each capped at 60s to avoid blocking workflow)
  // Phase 1a.3 fix: use `bunx tsc` (not bare `tsc`) so the binary resolves on a fresh
  // sandbox without a global TypeScript install. Also run the two in parallel via Promise.all
  // (the prior sequential `await ×2` doubled latency for no good reason).
  const [lintResult, tscResult] = await Promise.all([
    runShellSafe('bun run lint', 60_000),
    runShellSafe('bunx tsc --noEmit', 60_000),
  ])

  const lintErrors = parseLintErrors(lintResult.stderr + lintResult.stdout)
  const tscErrors = parseTscErrors(tscResult.stderr + tscResult.stdout)

  const report: QualityReport = {
    mode,
    lintErrors: lintErrors.count,
    tscErrors: tscErrors.count,
    lintSample: lintErrors.sample,
    tscSample: tscErrors.sample,
    durationMs: Date.now() - startedAt,
  }

  // Strict mode: any quality errors halt the workflow so they can be fixed
  // before reaching git_commit / deploy. Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md
  // Part 4 Phase 1a.3 (warn | strict | off). In `warn` we log + continue; in `strict`
  // we throw so the upstream workflow engine catches and reports the failure.
  if (mode === 'strict' && (report.lintErrors > 0 || report.tscErrors > 0)) {
    const samples = [
      ...(report.lintSample || []).map(s => `lint: ${s}`),
      ...(report.tscSample || []).map(s => `tsc: ${s}`),
    ].slice(0, 5)
    throw new Error(
      `Quality gate strict mode failed: ${report.lintErrors} lint errors, ${report.tscErrors} tsc errors. Samples:\n${samples.join('\n')}`,
    )
  }

  return report
}

async function runShellSafe(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: await resolveWorkspaceRoot(),
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    })
    return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 }
  } catch (err: any) {
    return {
      stdout: err?.stdout || '',
      stderr: err?.stderr || err?.message || String(err),
      exitCode: err?.code ?? 1,
    }
  }
}

function parseLintErrors(output: string): { count: number; sample: string[] } {
  // ESLint default output: "<file>:<line>:<col>: <severity> <rule> <message>"
  // Or compact: "  <N> errors (M fixable)"
  const errorLines = output.split('\n').filter(l => /error|Error/.test(l) && !l.includes('0 errors'))
  const countMatch = output.match(/(\d+)\s+errors?/)
  const count = countMatch ? parseInt(countMatch[1], 10) : errorLines.length
  const sample = errorLines.slice(0, 5).map(l => l.slice(0, 200))
  return { count, sample }
}

function parseTscErrors(output: string): { count: number; sample: string[] } {
  // TSC output: "<file>(<line>,<col>): error TS<code>: <message>"
  const tscErrors = output.split('\n').filter(l => /: error TS\d+:/.test(l))
  const sample = tscErrors.slice(0, 5).map(l => l.slice(0, 200))
  return { count: tscErrors.length, sample }
}

// ==================== CONSTANTS ====================

/** Timeout for each LLM call inside an agent step (ReAct loop).
 *  If the LLM hangs beyond this, the step is aborted with an error,
 *  and the workflow continues to the next pipeline step (graceful degradation). */
const AGENT_STEP_TIMEOUT_MS = 120_000 // 2 minutes per LLM call in agent step

/** Shorter timeout for TL checkpoint verification calls — these are brief decisions, not long code generation. */
const CHECKPOINT_VERIFY_TIMEOUT_MS = 30_000 // 30 seconds for checkpoint verify

// v2.1 Phase 5.6 — Context overflow threshold (Appendix C.4 step 1).
// 80k tokens triggers a session pause + resume handoff so a new agent can
// re-inject the original task + last 5 tool receipts + current step.
// Configurable via CONTEXT_OVERFLOW_THRESHOLD env var.
const CONTEXT_OVERFLOW_THRESHOLD =
  parseInt(process.env.CONTEXT_OVERFLOW_THRESHOLD || '80000', 10) || 80000


// ==================== TYPES ====================

/** SSE emitter function — sends events to client */
export type SSEEmitter = (event: WorkflowEvent) => void

/** Workflow SSE event types */
export interface WorkflowEvent {
  type:
    | 'workflow_start'
    | 'agent_start'
    | 'agent_chunk'
    | 'agent_complete'
    | 'tool_call'
    | 'tool_result'
    | 'checkpoint'
    | 'iteration'
    | 'workflow_done'
    | 'error'
  [key: string]: unknown
}

/** Incoming workflow request */
interface WorkflowRequest {
  messages: Array<{ role: string; content: string }>
  sessionId: string
  userRequest: string
  /** Pre-computed routing from TL Assessment (Phase 2: Smart TL Bridge)
   *  If provided, TL analyze step is SKIPPED and pipeline starts immediately.
   *  This saves ~3-5s by avoiding a redundant LLM call when TL already assessed.
   */
  routing?: RoutingDecision
}

/** Workflow configuration — controls behavior of the workflow engine */
export interface WorkflowConfig {
  /** When true, the workflow continues running in the backend even after the client
   *  disconnects. SSE events are silently dropped, but DB writes (worklog, session)
   *  still happen. This is the recommended behavior for long-running workflows.
   *  Default: true */
  continueOnDisconnect?: boolean
}

/** Cached resolved agents for the current workflow run
 *  NOTE: Passed as parameter to avoid module-level state race conditions
 *  when multiple workflows run concurrently.
 */

/** Agent position type */
type AgentPosition = 'TL' | 'G1' | 'G2-A' | 'G2-B' | 'G3'

/** Pipeline step definition */
interface PipelineStep {
  position: AgentPosition
  step: string // analyze | design | code | review | optimize | verify
  isCheckpoint: boolean // TL verify after this step?
  description: string
}

// ==================== PIPELINE DEFINITIONS ====================
// From workflow doc: "3-TIER WORKFLOW" + "HỆ THỐNG ROUTING — 3 CHẾ ĐỘ DISPATCH"

/**
 * Get pipeline steps based on routing mode and tier.
 *
 * Mode A (Pure Visual): TL→TL→G2-B→TL — TL codes UI, self-verify, G2-B review, TL final verify
 * Mode B (Pure Backend): Uses tier pipeline — TL only analyzes + verifies
 * Mode C (Hybrid): TL codes UI first, then backend pipeline WITH G3 (integration)
 */
export function getPipeline(mode: 'A' | 'B' | 'C', tier: 1 | 2 | 3): PipelineStep[] {
  // Mode A: Pure Visual — TL→TL→TL→G2-B→TL (workflow doc: ANALYZE, CODE, SELF-VERIFY, G2-B review, TL final verify)
  if (mode === 'A') {
    return [
      { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Phân tích visual request + Routing decision' },
      { position: 'TL', step: 'code', isCheckpoint: false, description: 'TL code UI (Fast Track)' },
      { position: 'TL', step: 'verify', isCheckpoint: true, description: 'TL self-verify: so với mockup. <85% → iterate (max 3). ≥85% → chuyển G2-B' },
      { position: 'G2-B', step: 'review', isCheckpoint: false, description: 'Review code quality (semantic, accessibility, responsive)' },
      { position: 'TL', step: 'verify', isCheckpoint: false, description: 'TL final visual verify' },
    ]
  }

  // Mode C (Hybrid): TL codes UI first, then backend pipeline → G3 ALWAYS included for UI↔Backend integration
  // Workflow doc: "TL(UI) ‖ G1→G2-A→G2-B(BE) → G3(integration) → TL"
  if (mode === 'C') {
    if (tier === 1) {
      return [
        { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Phân tích request + Routing decision' },
        { position: 'TL', step: 'code', isCheckpoint: false, description: 'TL code UI (Fast Track cho phần visual)' },
        { position: 'G2-B', step: 'review', isCheckpoint: true, description: 'Review + fix minor issues — CP1' },
        { position: 'G3', step: 'optimize', isCheckpoint: true, description: 'UI↔Backend integration — CP2' },
        { position: 'TL', step: 'verify', isCheckpoint: false, description: 'TL final verify' },
      ]
    }
    if (tier === 2) {
      return [
        { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Phân tích request + Routing decision' },
        { position: 'TL', step: 'code', isCheckpoint: false, description: 'TL code UI (Fast Track cho phần visual)' },
        { position: 'G1', step: 'design', isCheckpoint: true, description: 'Thiết kế kiến trúc backend — CP1' },
        { position: 'G2-A', step: 'code', isCheckpoint: true, description: 'Code backend theo arch spec — CP2' },
        { position: 'G2-B', step: 'review', isCheckpoint: true, description: 'Review + fix bugs — CP3' },
        { position: 'G3', step: 'optimize', isCheckpoint: true, description: 'Optimize + UI↔Backend integration — CP4' },
        { position: 'TL', step: 'verify', isCheckpoint: false, description: 'TL final verify' },
      ]
    }
    // Tier 3: Complex
    return [
      { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Phân tích request + Routing decision' },
      { position: 'TL', step: 'code', isCheckpoint: false, description: 'TL code UI (Fast Track cho phần visual)' },
      { position: 'G1', step: 'design', isCheckpoint: true, description: 'Thiết kế kiến trúc backend — CP1' },
      { position: 'G2-A', step: 'code', isCheckpoint: true, description: 'Code backend theo arch spec — CP2' },
      { position: 'G2-B', step: 'review', isCheckpoint: true, description: 'Review + fix bugs — CP3' },
      { position: 'G3', step: 'optimize', isCheckpoint: true, description: 'Optimize + UI↔Backend integration — CP4' },
      { position: 'TL', step: 'verify', isCheckpoint: false, description: 'TL final verify' },
    ]
  }

  // Mode B (Pure Backend): standard tier pipeline — TL only analyzes + verifies
  if (tier === 1) {
    return [
      { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Phân tích request + Routing decision' },
      { position: 'G2-B', step: 'review', isCheckpoint: true, description: 'Review + fix minor issues' },
      { position: 'TL', step: 'verify', isCheckpoint: false, description: 'TL final verify' },
    ]
  }

  if (tier === 2) {
    return [
      { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Phân tích request + Routing decision' },
      { position: 'G1', step: 'design', isCheckpoint: true, description: 'Thiết kế kiến trúc — CP1' },
      { position: 'G2-A', step: 'code', isCheckpoint: true, description: 'Code theo arch spec — CP2' },
      { position: 'G2-B', step: 'review', isCheckpoint: true, description: 'Review + fix bugs — CP3' },
      { position: 'TL', step: 'verify', isCheckpoint: false, description: 'TL final verify' },
    ]
  }

  // Tier 3: Complex — TL→G1→G2-A→G2-B→G3→TL
  return [
    { position: 'TL', step: 'analyze', isCheckpoint: false, description: 'Phân tích request + Routing decision' },
    { position: 'G1', step: 'design', isCheckpoint: true, description: 'Thiết kế kiến trúc — CP1' },
    { position: 'G2-A', step: 'code', isCheckpoint: true, description: 'Code theo arch spec — CP2' },
    { position: 'G2-B', step: 'review', isCheckpoint: true, description: 'Review + fix bugs — CP3' },
    { position: 'G3', step: 'optimize', isCheckpoint: true, description: 'Optimize — CP4' },
    { position: 'TL', step: 'verify', isCheckpoint: false, description: 'TL final verify' },
  ]
}

// ==================== SKILL LOADING ====================

/** Load enabled skills from DB and format them for injection into agent prompts.
 *  Cached per-workflow to avoid repeated DB queries.
 *  NOTE: Skills are injected via TWO mechanisms serving DIFFERENT paths:
 *    1. DB → systemPrompt (this code) — used by OpenClaw Chat & Workflow Engine
 *    2. Filesystem (skills/<slug>/SKILL.md) — used by z.ai platform sandbox
 *    Do NOT add a third injection point without checking for duplication. */
async function loadEnabledSkills(): Promise<string> {
  try {
    // Load ALL enabled skills — skills are global (not per-agent)
    const skills = await db.agentSkill.findMany({
      where: { enabled: true },
      select: { name: true, slug: true, content: true },
    })
    if (skills.length === 0) return ''
    // Token budget: limit skills injection to ~4K tokens (~16K chars) to avoid bloating system prompt
    const MAX_SKILLS_CHARS = 16000
    let skillsText = ''
    for (const s of skills) {
      const section = `## Skill: ${s.name} (${s.slug})\n${s.content}\n\n---\n\n`
      if ((skillsText + section).length > MAX_SKILLS_CHARS) {
        skillsText += `## Skill: ${s.name} (${s.slug})\n[Content truncated — skill content too large.]\n\n---\n\n`
        break
      }
      skillsText += section
    }
    return `\n\n━━━ AVAILABLE SKILLS ━━━\nBạn có quyền truy cập các skills sau. Mỗi skill là hướng dẫn cho bạn KHI NÀO và CÁCH NÀO sử dụng một khả năng cụ thể. Tuân theo hướng dẫn trong mỗi skill khi tình huống yêu cầu.\n\n${skillsText}━━━ END SKILLS ━━━`
  } catch {
    return '' // Never break workflow if DB is unavailable
  }
}

// ==================== MAIN WORKFLOW RUNNER ====================

/**
 * Run the Code Team workflow.
 *
 * Workflow doc: "CƠ CHẾ THỰC THI TUẦN TỰ — Xử lý tuần tự, không song song"
 * Each agent step runs sequentially, not in parallel.
 *
 * @param request - Workflow request with messages, sessionId, userRequest
 * @param emit - SSE emitter function for sending events to client
 * @param abortSignal - Optional AbortSignal to cancel workflow when client disconnects
 */
/** Per-workflow run context — avoids module-level state for concurrent safety
 *
 *  v2.1 Phase 5.1 — exported so master-orchestrator.ts can construct a minimal
 *  context when wiring `executeStep()` to `runAgentStep()` (see createMinimalWorkflowContext). */
export interface WorkflowContext {
  resolvedAgentsCache: Map<string, ResolvedAgent>
  /** Cached skills injection string — loaded once per workflow run to avoid repeated DB queries */
  skillsContext?: string
}

export async function runWorkflow(
  request: WorkflowRequest,
  emit: SSEEmitter,
  abortSignal?: AbortSignal,
  config?: WorkflowConfig
): Promise<void> {
  const startTime = Date.now()
  const { sessionId, userRequest, messages } = request
  const continueOnDisconnect = config?.continueOnDisconnect ?? true

  // Per-workflow context — each workflow run has its own cache
  const ctx: WorkflowContext = {
    resolvedAgentsCache: new Map(),
  }

  // Load enabled skills once for the entire workflow run — cached in ctx.skillsContext
  ctx.skillsContext = await loadEnabledSkills()

  // Track whether client has disconnected
  let clientDisconnected = false

  // Wrap emit: after client disconnects, silently drop SSE events but continue workflow
  const safeEmit: SSEEmitter = (event: WorkflowEvent) => {
    if (clientDisconnected && continueOnDisconnect) return
    try {
      emit(event)
    } catch {
      // Emit failed (stream closed) — mark as disconnected
      clientDisconnected = true
      if (continueOnDisconnect) {
        console.log(`[Workflow] Client disconnected for session ${sessionId} — workflow continues in background`)
      }
    }
  }

  // Helper: Check if workflow should abort
  // When continueOnDisconnect is true, client disconnect does NOT abort the workflow
  const isAborted = () => {
    if (abortSignal?.aborted === true) {
      if (continueOnDisconnect && clientDisconnected) {
        // Client disconnected but we continue — just skip SSE events
        return false
      }
      return true
    }
    return false
  }

  console.log(`[Workflow] Starting workflow for session ${sessionId}: "${userRequest.slice(0, 100)}" (continueOnDisconnect: ${continueOnDisconnect})`)
  safeEmit({ type: 'workflow_start', sessionId })

  // Phase 2 SMOLAB Proposal 7 — Initialize Layer 9 MetricsCollector.
  // Phantom-wired before: master-orchestrator had Layer 9 but wasn't the
  // production path (ENABLE_MASTER_ORCHESTRATOR=false). Now runWorkflow
  // (the real path) creates + flushes metrics so ExecutionMetrics actually
  // persists to SQLite via the Prisma model added in Phase 6 Prop 2.
  // Declared outside try{} so the catch block can flush even on early
  // catastrophic failure (TL resolution error, etc.).
  // routingMode/tier: use pre-computed routing from request if available
  // (Path A from TL Assessment API). For normal flow (Path B), TL analyze
  // produces routing AFTER workflow_start emit — but we don't want to block
  // metrics initialization on that, so we use safe defaults ('A'/1) and
  // the metrics still capture total runtime + step counts correctly. The
  // routing info is also stored in WorkflowSession row via upsertSession
  // (line 738); ExecutionMetrics is a side-effect audit trail, not the
  // source of truth for routing decisions.
  const metricsCollector: MetricsCollector = createMetricsCollector(
    sessionId,
    sessionId, // planId = sessionId for now (no separate plan table)
    request.routing?.mode ?? 'A', // routingMode (A/B/C from TL assessment)
    request.routing?.tier ?? 1,   // tier (1/2/3 from TL assessment)
    100000 // Default token budget — placeholder, real budget computed later
  )

  try {
    // ===== STEP 0: Resolve TL agent (Agent Resolution Layer — C1 Fix) =====
    // Resolve TL first — needed for routing analysis
    // If TL is missing from DB, lazy seed from hardcoded definition
    if (isAborted()) { console.log('[Workflow] Aborted before agent resolution'); return }

    const tlResolved = await resolveAgent('TL')
    ctx.resolvedAgentsCache.set('TL', tlResolved)

    if (tlResolved.source === 'missing') {
      const errorMsg = 'Không tìm thấy agent TL (APEX). Workflow cần ít nhất agent TL để chạy.'
      console.error(`[Workflow] ${errorMsg}`)
      safeEmit({ type: 'error', agent: 'SYSTEM', message: errorMsg })
      // Phase 2 SMOLAB Proposal 7 — flush Layer 9 metrics even on early abort
      // (fire-and-forget; never crash the workflow here).
      await metricsCollector.flush().catch((mErr) => {
        console.error('[Workflow] Layer 9 flush failed (TL missing path):', mErr)
      })
      await completeSession(sessionId, 'failed')
      return
    }

    console.log(`[Workflow] TL resolved: ${tlResolved.name} (source: ${tlResolved.source}, provider: ${tlResolved.provider}/${tlResolved.model})`)

    // ===== PHASE 2: Smart TL Bridge — Skip TL analyze if pre-computed routing available =====
    // If routing was already computed by TL Assessment (POST /api/code-team/assess),
    // skip the TL analyze step and go straight to pipeline.
    // This saves ~3-5s by avoiding a redundant LLM call.
    const preComputedRouting = request.routing
    if (preComputedRouting) {
      console.log(`[Workflow] Using pre-computed routing from TL Assessment: Mode ${preComputedRouting.mode}, Tier ${preComputedRouting.tier}, Score ${preComputedRouting.score}`)

      // Write TL worklog with pre-computed routing
      const tlWorklogEntry: WorklogEntry = {
        sessionId,
        agentName: tlResolved.name,
        position: 'TL',
        step: 'analyze',
        timestamp: new Date(),
        summary: `TL routing (pre-assessed): Mode ${preComputedRouting.mode}, Tier ${preComputedRouting.tier}, Score ${preComputedRouting.score}. ${preComputedRouting.reasoning.slice(0, 200)}`,
        completed: ['routing_analysis', `mode_${preComputedRouting.mode}`, `tier_${preComputedRouting.tier}`],
        inProgress: [],
        issues: [],
        suggestions: [],
        concerns: [],
        codeLocationMap: { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
        nextSteps: preComputedRouting.tier === 1 ? ['G2-B review'] : ['G1 thiết kế kiến trúc'],
        outputForNext: preComputedRouting.spec || userRequest,
        routingDecision: preComputedRouting,
      }
      await writeWorklog(tlWorklogEntry, 0)

      // Save routing decision into session
      await upsertSession({
        sessionId,
        routingMode: preComputedRouting.mode,
        tier: preComputedRouting.tier,
        score: preComputedRouting.score,
        currentStep: 'running',
        currentAgent: 'TL',
        partsDefinition: preComputedRouting.parts,
      })

      // Skip TL analyze — go straight to pipeline
      await runPipeline(preComputedRouting, sessionId, userRequest, safeEmit, startTime, isAborted, ctx, metricsCollector)
      return
    }

    // ===== STEP 1: TL phân tích routing (normal flow — no pre-computed routing) =====
    if (isAborted()) { console.log('[Workflow] Aborted before TL analyze'); return }
    // Workflow doc: "TL (Kimi) là bộ điều hướng thông minh. Mỗi request được phân loại và đi đúng tuyến"

    const agentDef = tlResolved
    safeEmit({
      type: 'agent_start',
      agent: agentDef.name,
      position: 'TL',
      step: 'analyze',
      avatar: agentDef.avatar,
    })

    const tlResult = await runAgentStep({
      position: 'TL',
      step: 'analyze',
      prompt: buildTLPrompt(userRequest, messages),
      sessionId,
      emit: safeEmit,
      ctx,
    })

    safeEmit({
      type: 'agent_complete',
      agent: agentDef.name,
      position: 'TL',
      step: 'analyze',
      content: tlResult.content,
      duration: tlResult.duration,
    })

    // Parse routing decision from TL output
    const routingDecision = parseRoutingDecision(tlResult.content)
    if (!routingDecision) {
      // Fallback: If TL didn't produce valid routing, use defaults
      console.warn('[Workflow] TL failed to produce routing decision, using defaults (Mode B, Tier 2)')
      const fallbackDecision: RoutingDecision = {
        mode: 'B',
        tier: 2,
        score: 5,
        reasoning: 'TL không đưa ra routing decision hợp lệ. Sử dụng mặc định: Mode B (Backend), Tier 2 (Medium).',
        parts: [{ name: 'main', type: 'backend', description: userRequest, dependency: [] }],
      }

      // Write TL worklog even on fallback
      const tlWorklogEntry: WorklogEntry = {
        sessionId,
        agentName: agentDef.name,
        position: 'TL',
        step: 'analyze',
        timestamp: new Date(),
        summary: `TL phân tích (fallback routing): ${tlResult.content.slice(0, 300)}`,
        completed: ['routing_analysis'],
        inProgress: [],
        issues: [{ severity: 'medium', type: 'logic', description: 'TL không đưa ra routing decision JSON hợp lệ, sử dụng fallback' }],
        suggestions: ['Review TL prompt để đảm bảo output format đúng'],
        concerns: [],
        codeLocationMap: { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
        nextSteps: ['G1 thiết kế kiến trúc'],
        outputForNext: tlResult.content,
        routingDecision: fallbackDecision,
      }
      await writeWorklog(tlWorklogEntry, tlResult.duration)

      await upsertSession({
        sessionId,
        routingMode: fallbackDecision.mode,
        tier: fallbackDecision.tier,
        score: fallbackDecision.score,
        currentStep: 'running',
        currentAgent: 'TL',
        partsDefinition: fallbackDecision.parts,
      })

      await runPipeline(fallbackDecision, sessionId, userRequest, safeEmit, startTime, isAborted, ctx, metricsCollector)
      return
    }

    console.log(`[Workflow] Routing: Mode ${routingDecision.mode}, Tier ${routingDecision.tier}, Score ${routingDecision.score}`)
    console.log(`[Workflow] Reasoning: ${routingDecision.reasoning}`)

    // Write TL worklog
    const tlWorklogEntry: WorklogEntry = {
      sessionId,
      agentName: agentDef.name,
      position: 'TL',
      step: 'analyze',
      timestamp: new Date(),
      summary: `TL routing: Mode ${routingDecision.mode}, Tier ${routingDecision.tier}, Score ${routingDecision.score}. ${routingDecision.reasoning.slice(0, 200)}`,
      completed: ['routing_analysis', `mode_${routingDecision.mode}`, `tier_${routingDecision.tier}`],
      inProgress: [],
      issues: [],
      suggestions: [],
      concerns: [],
      codeLocationMap: { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
      nextSteps: routingDecision.tier === 1 ? ['G2-B review'] : ['G1 thiết kế kiến trúc'],
      outputForNext: routingDecision.spec || userRequest,
      routingDecision,
    }
    await writeWorklog(tlWorklogEntry, tlResult.duration)

    // Save routing decision into session
    await upsertSession({
      sessionId,
      routingMode: routingDecision.mode,
      tier: routingDecision.tier,
      score: routingDecision.score,
      currentStep: 'running',
      currentAgent: 'TL',
      partsDefinition: routingDecision.parts,
    })

    // ===== STEP 2: Run pipeline based on routing =====
    await runPipeline(routingDecision, sessionId, userRequest, safeEmit, startTime, isAborted, ctx, metricsCollector)
  } catch (err) {
    // Phase 2 SMOLAB Proposal 7 — flush Layer 9 metrics on any catastrophic
    // failure (fire-and-forget; never crash the workflow here).
    await metricsCollector.flush().catch((mErr) => {
      console.error('[Workflow] Layer 9 flush failed (catch path):', mErr)
    })
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`[Workflow] Fatal error:`, errorMsg)
    safeEmit({ type: 'error', agent: 'SYSTEM', message: errorMsg })

    // Mark session as failed
    try {
      await completeSession(sessionId, 'failed')
    } catch {}
  }
}

// ==================== PIPELINE RUNNER ====================

/**
 * Run the pipeline steps sequentially.
 * Each step runs an agent, writes worklog, and optionally does checkpoint verification.
 */
async function runPipeline(
  routingDecision: RoutingDecision,
  sessionId: string,
  userRequest: string,
  emit: SSEEmitter,
  workflowStartTime: number,
  isAborted: () => boolean,
  ctx: WorkflowContext,
  // Phase 2 SMOLAB Proposal 7 — Layer 9 MetricsCollector.
  // Passed from runWorkflow so flush() can be called at all early-exit
  // points (escalate, abort, completed) — fire-and-forget, never
  // blocks the workflow.
  metricsCollector: MetricsCollector,
): Promise<void> {
  const pipeline = getPipeline(routingDecision.mode, routingDecision.tier)
  let spec = routingDecision.spec || userRequest // Spec gốc cho toàn bộ pipeline

  // Get TL agent name from resolved cache (BUG 12 fix: don't hardcode 'APEX')
  const tlAgent = ctx.resolvedAgentsCache.get('TL')
  const completedAgents: string[] = tlAgent ? [tlAgent.name] : ['APEX'] // TL already completed in Step 1

  // ===== v2.1 Phase 4.3 — Staging branch per workflow =====
  // All file_edit/git_commit ops during the workflow target this branch (not main).
  // Created BEFORE agents run so the first edit lands on the staging branch.
  // Gated by ENABLE_STAGING_BRANCH (default true in .env). If git working tree
  // is dirty or git is unavailable, we warn + skip (don't block the workflow).
  const stagingBranch = await createStagingBranch(sessionId)
  if (stagingBranch) {
    emit({
      type: 'checkpoint',
      after: 'TL',
      step: 'analyze',
      decision: 'STAGING_BRANCH_CREATED',
      reasoning: `Edits target ${stagingBranch} (will be merged back at workflow end)`,
    } as WorkflowEvent)
  }

  // ===== RESOLVE ALL PIPELINE AGENTS (Agent Resolution Layer — C1 Fix) =====
  const uniquePositions = [...new Set(pipeline.map(s => s.position))]
  const resolutionResult = await resolveAllAgents(uniquePositions)
  console.log(`[Workflow] Agent resolution: ${getResolutionSummary(resolutionResult)}`)

  // If any positions are missing, emit error but continue with available agents
  if (resolutionResult.missingPositions.length > 0) {
    const missingMsg = `⚠️ Không tìm thấy agents cho positions: ${resolutionResult.missingPositions.join(', ')}. Workflow có thể không hoàn thành.`
    console.warn(`[Workflow] ${missingMsg}`)
    emit({ type: 'error', agent: 'SYSTEM', message: missingMsg })
  }

  // Cache resolved agents for use in runAgentStep
  for (const [position, agent] of resolutionResult.agents) {
    ctx.resolvedAgentsCache.set(position, agent)
  }

  for (let i = 0; i < pipeline.length; i++) {
    const step = pipeline[i]

    // Check if workflow was aborted (client disconnected)
    if (isAborted()) {
      console.log(`[Workflow] Aborted at step ${i} (${step.position}/${step.step}) — client disconnected`)
      // Phase 2 SMOLAB Proposal 7 — flush Layer 9 metrics before early-exit.
      await metricsCollector.flush().catch((mErr) => {
        console.error('[Workflow] Layer 9 flush failed (abort path):', mErr)
      })
      await completeSession(sessionId, 'failed', Date.now() - workflowStartTime, completedAgents)
      return
    }

    // Skip TL analyze — already ran in Step 1
    if (step.position === 'TL' && step.step === 'analyze') continue

    // Update session
    await upsertSession({
      sessionId,
      currentAgent: step.position,
      currentStep: 'running',
      completedAgents,
    })

    // Build context for this agent
    // Workflow doc: "3 Lớp thông tin" — SPEC + WORKLOG + CODE
    const context = await buildContextForAgent(sessionId, step.position, spec)

    // Run agent step — resolve from cache (already resolved in pipeline setup)
    const agentDef = ctx.resolvedAgentsCache.get(step.position) || await resolveAgent(step.position)

    // Skip step if agent is missing (no provider/model) — graceful degradation
    if (agentDef.source === 'missing' || !agentDef.provider || !agentDef.model) {
      console.warn(`[Workflow] Skipping step ${step.position}/${step.step} — agent not available`)
      emit({
        type: 'error',
        agent: step.position,
        position: step.position,
        message: `Agent ${step.position} không khả dụng. Bỏ qua bước ${step.description}.`,
      })
      continue
    }

    emit({
      type: 'agent_start',
      agent: agentDef.name,
      position: step.position,
      step: step.step,
      avatar: agentDef.avatar,
      description: step.description,
    })

    // Phase 2 SMOLAB Proposal 7 — Record step start for Layer 9 metrics.
    // stepId format matches master-orchestrator.ts:239 (`${position}-${step}`).
    const stepId = `${step.position}-${step.step}`
    metricsCollector.recordStepStart(stepId, step.step, step.position)

    const agentResult = await runAgentStep({
      position: step.position,
      step: step.step,
      prompt: context,
      sessionId,
      emit,
      ctx,
      // G2-B max 3 vòng iteration (workflow doc: "max 3 vòng iteration")
      // TL self-verify (Mode A) max 3 vòng iterate (workflow doc: "tối đa 3 vòng")
      // Others max 10
      maxIterations: (step.position === 'G2-B' || (step.position === 'TL' && step.step === 'verify')) ? 3 : 10,
    })

    // Parse worklog from agent output
    // Edge case: If content starts with "Error:" → agent step failed
    // Write a minimal worklog marking the step as failed so subsequent agents have context
    const isFailedStep = agentResult.content.startsWith('Error:')
    const parsedWorklog = parseWorklogFromOutput(agentResult.content)

    // Phase 2 SMOLAB Proposal 7 — Record step completion/error for Layer 9.
    // If isFailedStep, also push an ErrorRecord into the step's error log so
    // errorsByType aggregation in getCurrentMetrics() captures the failure.
    // tokensUsed=0 placeholder (real tracking would require plumbing LLM
    // token counts through runAgentStep — deferred per spec: "Don't add
    // recordTokenUsage calls"). timeSpent from agentResult.duration (ms).
    if (isFailedStep) {
      metricsCollector.recordStepError(stepId, {
        id: `err-${sessionId}-${stepId}-${Date.now()}`,
        timestamp: new Date(),
        errorType: 'runtime',
        severity: 'high',
        message: agentResult.content.slice(0, 500),
        rootCause: 'Agent step returned Error: prefix',
        fixStrategy: 'surgical',
        fixApplied: false,
        loopDetected: false,
        loopCount: 0,
      })
    }
    metricsCollector.recordStepComplete(
      stepId,
      {
        success: !isFailedStep,
        filesCreated: [],
        filesModified: [],
        summary: isFailedStep
          ? `Step ${stepId} failed`
          : (parsedWorklog?.summary || `Step ${stepId} executed`).slice(0, 500),
        outputForNext: isFailedStep
          ? agentResult.content.slice(0, 2000)
          : (parsedWorklog?.outputForNext || agentResult.content.slice(0, 2000)),
      },
      0, // tokensUsed — placeholder (see comment above)
      agentResult.duration, // timeSpent (ms)
    )

    const worklogEntry: WorklogEntry = {
      sessionId,
      agentName: agentDef.name,
      position: step.position,
      step: step.step,
      timestamp: new Date(),
      summary: isFailedStep
        ? `⚠️ Step failed: ${agentResult.content.slice(0, 300)}`
        : (parsedWorklog?.summary || agentResult.content.slice(0, 300)),
      completed: parsedWorklog?.completed || [],
      inProgress: parsedWorklog?.inProgress || [],
      issues: isFailedStep
        ? [{ severity: 'high', type: 'logic', description: `Agent step failed: ${agentResult.content.slice(0, 200)}`, fixApplied: false }]
        : (parsedWorklog?.issues || []),
      suggestions: parsedWorklog?.suggestions || [],
      concerns: parsedWorklog?.concerns || [],
      codeLocationMap: parsedWorklog?.codeLocationMap || { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
      nextSteps: parsedWorklog?.nextSteps || [],
      outputForNext: isFailedStep
        ? `Step ${step.position}/${step.step} failed. ${agentResult.content.slice(0, 500)}`
        : (parsedWorklog?.outputForNext || agentResult.content.slice(0, 2000)),
      unfixedBugs: parsedWorklog?.unfixedBugs,
      kbWrites: parsedWorklog?.kbWrites,
    }
    await writeWorklog(worklogEntry, agentResult.duration)

    completedAgents.push(agentDef.name)

    emit({
      type: 'agent_complete',
      agent: agentDef.name,
      position: step.position,
      step: step.step,
      content: agentResult.content,
      duration: agentResult.duration,
    })

    // ===== CHECKPOINT VERIFY =====
    // Workflow doc: "READ-WRITE-VERIFY LOOP — TL là Agentic Loop Controller"
    if (step.isCheckpoint) {
      emit({ type: 'checkpoint', after: step.position, step: step.step, pending: true })

      const verifyResult = await runTLCheckpointVerify(sessionId, spec, emit, ctx)
      if (verifyResult.decision === 'ESCALATE') {
        const tlName = ctx.resolvedAgentsCache.get('TL')?.name || 'TL'
        emit({
          type: 'error',
          agent: tlName,
          message: `ESCALATE sau ${step.position}: ${verifyResult.reasoning}`,
        })

        // ===== v2.1 Phase 4.2 — Auto-restore on verify failure =====
        // Spec line 253: "When TL checkpoint verify returns 'PIVOT' or 'ESCALATE'
        // or a verify error occurs, auto-restore the latest checkpoint for that session."
        // Honor ENABLE_AUTO_RESTORE flag (off | warn | strict).
        // Phase 4 audit fix (Task 11, P1-2): also restore the fs-checkpoint
        // (files), not just Neo4j. The auto-checkpoint before risky ops takes
        // BOTH Neo4j + fs snapshots; restore must be symmetric or the fs
        // snapshot is dead weight.
        await autoRestoreOnVerifyFailure({
          sessionId,
          reason: `ESCALATE sau ${step.position}: ${verifyResult.reasoning}`,
        })
        await autoRestoreFsOnVerifyFailure({
          sessionId,
          reason: `ESCALATE sau ${step.position}: ${verifyResult.reasoning}`,
          workspaceRoot: await getWorkspaceRoot(),
        })

        // Still complete the session as failed
        const totalDuration = Date.now() - workflowStartTime
        // Phase 2 SMOLAB Proposal 7 — flush Layer 9 metrics before early-exit
        // (escalate path). Fire-and-forget; never block the workflow.
        await metricsCollector.flush().catch((mErr) => {
          console.error('[Workflow] Layer 9 flush failed (escalate path):', mErr)
        })
        await completeSession(sessionId, 'failed', totalDuration)
        emit({ type: 'workflow_done', totalDuration, sessionId, status: 'escalated' })
        return
      }
      if (verifyResult.decision === 'PIVOT') {
        spec = verifyResult.updatedSpec || spec

        // ===== v2.1 Phase 4.2 — Auto-restore on verify failure (PIVOT case) =====
        // PIVOT means the direction needs to change → restore the latest checkpoint
        // so the agent doesn't continue building on a wrong foundation.
        // Phase 4 audit fix (Task 11, P1-2): also restore fs-checkpoint (files).
        await autoRestoreOnVerifyFailure({
          sessionId,
          reason: `PIVOT sau ${step.position}: ${verifyResult.reasoning}`,
        })
        await autoRestoreFsOnVerifyFailure({
          sessionId,
          reason: `PIVOT sau ${step.position}: ${verifyResult.reasoning}`,
          workspaceRoot: await getWorkspaceRoot(),
        })

        emit({
          type: 'checkpoint',
          after: step.position,
          step: step.step,
          decision: 'PIVOT',
          reasoning: verifyResult.reasoning,
        })
      } else {
        emit({
          type: 'checkpoint',
          after: step.position,
          step: step.step,
          decision: 'CONTINUE',
        })
      }
    }
  }

  // ===== v2.1 Phase 4.3 — Merge staging branch back to parent =====
  // Called at workflow end (success or completion_with_errors). Skipped on
  // workflow failure (escalated) — staging branch is left for manual inspection.
  await mergeStagingBranch(stagingBranch, sessionId)

  // ===== WORKFLOW DONE =====
  const totalDuration = Date.now() - workflowStartTime

  // v2.1 Phase 1a.3 — Quality gate (lint + tsc) before marking workflow complete.
  // Mode 'off' (default): skip entirely. 'warn': surface in payload but still 'completed'.
  // 'strict': if errors found, status becomes 'completed_with_errors'.
  const quality = await enforceQualityGate()
  let finalStatus: 'completed' | 'completed_with_errors' = 'completed'
  if (quality.mode === 'strict' && (quality.lintErrors > 0 || quality.tscErrors > 0)) {
    finalStatus = 'completed_with_errors'
    console.warn(`[Workflow] Quality gate FAILED (strict mode): lint=${quality.lintErrors} tsc=${quality.tscErrors} (${quality.durationMs}ms) — marking as completed_with_errors`)
  } else if (quality.mode === 'warn' && (quality.lintErrors > 0 || quality.tscErrors > 0)) {
    console.warn(`[Workflow] Quality gate warnings: lint=${quality.lintErrors} tsc=${quality.tscErrors} (${quality.durationMs}ms) — workflow still completed (warn mode)`)
  }

  await completeSession(sessionId, finalStatus, totalDuration, completedAgents)

  // Phase 2 SMOLAB Proposal 7 — flush Layer 9 metrics before workflow_done emit.
  // This is the SUCCESS path: every step recordStart/recordComplete has been
  // called inside the for-loop above. flush() persists ExecutionMetrics row
  // to SQLite (Prisma model added in Phase 6 Prop 2). Fire-and-forget pattern:
  // failure here does NOT change the workflow outcome (already completed).
  await metricsCollector.flush().catch((mErr) => {
    console.error('[Workflow] Layer 9 flush failed (success path):', mErr)
  })

  emit({
    type: 'workflow_done',
    totalDuration,
    sessionId,
    status: finalStatus,
    quality: quality.mode === 'off' ? undefined : quality,
  })
  console.log(`[Workflow] Completed in ${totalDuration}ms. Agents: ${completedAgents.join(' → ')} (quality: ${quality.mode})`)
}

// ==================== AGENT STEP RUNNER (ReAct Loop) ====================

/**
 * Run a single agent step with ReAct loop.
 *
 * ReAct loop: Reason → Act (tool_call) → Observe (tool_result) → Repeat
 * - If LLM returns tool_calls → execute tools → feed results back → repeat
 * - If LLM returns text (no tool_calls) → agent step complete
 * - Max iterations to prevent infinite loops
 *
 * @returns Agent's final output content and duration
 */
// v2.1 Phase 5.1 — exported so master-orchestrator.ts can dispatch a real agent
// step when ENABLE_MASTER_ORCHESTRATOR=true (see executeStep in master-orchestrator.ts).
export async function runAgentStep(params: {
  position: AgentPosition
  step: string
  prompt: string
  sessionId: string
  emit: SSEEmitter
  maxIterations?: number
  ctx: WorkflowContext
}): Promise<{ content: string; duration: number }> {
  const { position, step, prompt, sessionId, emit, maxIterations = 10, ctx } = params
  const stepStartTime = Date.now()

  // Resolve agent from per-workflow cache (populated by runPipeline) or on-demand
  const agent = ctx.resolvedAgentsCache.get(position) || await resolveAgent(position)
  const tools = agent.tools.length > 0 ? agent.tools : getAgentTools(position)
  let systemPrompt = agent.instruction || getAgentPrompt(position)

  // Inject enabled skills from DB (cached per-workflow in ctx.skillsContext)
  if (ctx.skillsContext) {
    systemPrompt += ctx.skillsContext
  }

  // ━━━ Phase 1c: Native Function Calling setup ━━━
  // Mode: 'off' (regex only) | 'dual' (native preferred, regex fallback) | 'strict' (native only)
  // When dual/strict: append tool schemas to system prompt (defense in depth) AND pass
  // tool definitions via LLMCallOptions.tools so NIM API includes them in the request.
  const fcMode = flagMode('ENABLE_NATIVE_FC', ['off', 'dual', 'strict']) as 'off' | 'dual' | 'strict'
  let nativeTools: LLMTool[] | undefined
  if (fcMode !== 'off') {
    const toolDefs = getToolDefinitionsForPosition(position)
    if (toolDefs.length > 0) {
      // ToolDefinition matches LLMTool shape exactly (both OpenAI-compatible)
      nativeTools = toolDefs as unknown as LLMTool[]
      systemPrompt += buildToolSchemasSection(toolDefs)
    }
  }

  // Build initial messages array for multi-turn conversation with tool calls
  const messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_call_id?: string
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]

  // NOTE: Tool definitions are not passed to callLLMForAgent because it doesn't support
  // native function calling. Instead, tools are parsed from LLM text output.
  // Tool definitions are defined in prompts.ts and agents parse tool calls from their output.

  let finalContent = ''
  let iterations = 0
  let totalToolCalls = 0
  // Phase 1c metrics: track native vs fallback success rate for dual-mode validation
  let nativeToolCallCount = 0
  let regexFallbackCount = 0
  const toolCallsLog: Array<{ tool: string; args: Record<string, unknown>; result: string; duration: number; success: boolean }> = []

  console.log(`[Workflow] Running agent: ${agent.name} (${position}) — ${step} [tools: ${tools.join(', ')}] [fc: ${fcMode}${nativeTools ? ` (${nativeTools.length} schemas)` : ''}]`)

  while (iterations < maxIterations) {
    iterations++

    // Build the prompt from conversation history
    // callLLMForAgent takes a single prompt string, so we format messages into it
    const formattedPrompt = formatMessagesForLLM(messages)

    // Call LLM for this agent — with timeout to prevent infinite hangs
    // Edge case #1: LLM timeout → emit error event, break ReAct loop
    //
    // Phase 1c: when fcMode is 'dual' or 'strict', pass tools/tool_choice via options.
    // tryProviderWithSlotKey will include them in the NIM API request body.
    // The response will contain result.tool_calls (parsed by tryProviderWithSlotKey).
    const llmCallPromise = callLLMForAgent(
      formattedPrompt,
      { provider: agent.provider, model: agent.model },
      systemPrompt,
      {
        agentId: position,
        agentName: agent.name,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
        ...(nativeTools && nativeTools.length > 0
          ? { tools: nativeTools, tool_choice: 'auto' as const }
          : {}),
      }
    )

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<LLMResult>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`LLM call timed out after ${AGENT_STEP_TIMEOUT_MS}ms`)), AGENT_STEP_TIMEOUT_MS)
    })

    let result: LLMResult
    try {
      result = await Promise.race([llmCallPromise, timeoutPromise])
    } catch (timeoutErr) {
      // Always clear timeout to prevent resource leak
      if (timeoutId) clearTimeout(timeoutId)
      // LLM call timed out — graceful degradation
      const timeoutMsg = timeoutErr instanceof Error ? timeoutErr.message : 'LLM call timed out'
      console.error(`[Workflow] ${agent.name} (${position}) LLM timeout: ${timeoutMsg}`)
      finalContent = `Error: ${timeoutMsg}`
      emit({
        type: 'error',
        agent: agent.name,
        position,
        message: timeoutMsg,
      })
      break
    } finally {
      // Clear timeout on success to prevent resource leak
      if (timeoutId) clearTimeout(timeoutId)
    }

    // result is guaranteed to be defined here because:
    // - If try succeeds: result is assigned, finally clears timeout, code continues
    // - If catch fires: break exits the while loop, this code is never reached
    if (!result || (result.error && !result.content)) {
      // LLM call completely failed
      finalContent = `Error: ${result.error}`
      emit({
        type: 'error',
        agent: agent.name,
        position,
        message: `LLM call failed: ${result.error}`,
      })
      break
    }

    finalContent = result.content

    // Emit chunk — REPLACE content (not append) because each ReAct iteration
    // returns the FULL LLM output, not incremental deltas.
    // If we appended, iterations would duplicate text.
    emit({
      type: 'agent_chunk',
      agent: agent.name,
      position,
      content: result.content,
      iteration: iterations,
    })

    // ━━━ Phase 1c: Tool call extraction — dual-mode ━━━
    // Strategy (per docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 4 Phase 1c.3):
    //   - 'off'    → regex only (current behavior, fully backward compatible)
    //   - 'dual'   → native tool_calls preferred; if empty, fall back to regex parsing
    //               and log a warning so success rate can be tracked per Part 10.4
    //   - 'strict' → native only; if empty, treat as "agent done" (no fallback)
    //
    // Native tool_calls come back from tryProviderWithSlotKey as result.tool_calls
    // (parsed from OpenAI-style response). Regex fallback parses the legacy
    // `tool_call: name({...})` text format from the LLM content.
    let toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []

    if (result.tool_calls && result.tool_calls.length > 0) {
      // ━━━ Native function calling path ━━━
      // Convert LLMToolCall[] (string arguments) → workflow's internal shape
      // (parsed args object). Skip any tool_call whose arguments fail JSON.parse.
      nativeToolCallCount += result.tool_calls.length
      for (const tc of result.tool_calls) {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(tc.function.arguments)
        } catch (parseErr) {
          console.warn(`[Workflow] ${agent.name} native tool_call ${tc.function.name} args JSON.parse failed — skipping. Raw: ${tc.function.arguments.slice(0, 200)}`)
          continue
        }
        toolCalls.push({
          id: tc.id || `native_${Date.now()}_${toolCalls.length}`,
          name: tc.function.name,
          args: parsedArgs,
        })
      }
      console.log(`[Workflow] ${agent.name} native tool_calls: ${result.tool_calls.length} (parsed ${toolCalls.length})`)

      // Phase 1c.3 fix — Dual-mode safety: if the model emitted native tool_calls but
      // EVERY one failed JSON.parse (rare — usually means malformed arguments),
      // fall back to regex parsing of the content text. This keeps the workflow
      // moving instead of silently ending the agent step with 0 tool calls.
      // Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Part 4 Phase 1c.3 + Part 10.4.
      if (fcMode === 'dual' && toolCalls.length === 0 && result.content) {
        const regexCalls = parseToolCallsFromOutput(result.content)
        if (regexCalls.length > 0) {
          regexFallbackCount += regexCalls.length
          console.warn(`[Workflow] ${agent.name} regex fallback used — native tool_calls were present but ALL ${result.tool_calls.length} failed JSON.parse; recovered ${regexCalls.length} from text. Fallback rate so far: ${regexFallbackCount}/${regexFallbackCount + nativeToolCallCount}`)
          toolCalls = regexCalls
        }
      }
    } else if (fcMode === 'dual') {
      // ━━━ Regex fallback path (dual mode only) ━━━
      // Model didn't emit native tool_calls despite receiving tools param.
      // Fall back to parsing the text output for `tool_call: name({...})` patterns.
      // This is expected during early dual-mode validation — once success rate ≥95%,
      // switch to strict mode (Part 14.3 A/B testing plan).
      const regexCalls = parseToolCallsFromOutput(result.content)
      if (regexCalls.length > 0) {
        regexFallbackCount += regexCalls.length
        console.warn(`[Workflow] ${agent.name} regex fallback used — ${regexCalls.length} tool calls parsed from text (native tool_calls empty, fcMode=dual). Fallback rate so far: ${regexFallbackCount}/${regexFallbackCount + nativeToolCallCount}`)
      }
      toolCalls = regexCalls
    } else if (fcMode === 'strict') {
      // Native only, no fallback. Empty tool_calls means agent is done.
      console.log(`[Workflow] ${agent.name} strict mode — no native tool_calls → treating as agent done`)
    } else {
      // ━━━ Regex path (fcMode='off') — current behavior, fully preserved ━━━
      toolCalls = parseToolCallsFromOutput(result.content)
    }

    if (toolCalls.length === 0) {
      // No tool calls → agent step complete
      console.log(`[Workflow] ${agent.name} step complete (no tool calls, ${iterations} iterations)`)
      break
    }

    // Execute tool calls
    console.log(`[Workflow] ${agent.name} calling ${toolCalls.length} tools (iteration ${iterations})`)

    // Emit iteration event for UI progress tracking
    emit({
      type: 'iteration',
      agent: agent.name,
      position,
      iteration: iterations,
      maxIterations,
    })

    // Add assistant message with tool calls to conversation
    messages.push({
      role: 'assistant',
      content: result.content,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    })

    for (const tc of toolCalls) {
      totalToolCalls++
      const toolStartTime = Date.now()

      emit({
        type: 'tool_call',
        agent: agent.name,
        position,
        tool: tc.name,
        detail: JSON.stringify(tc.args).slice(0, 200),
      })

      // ===== v2.1 Phase 4.1 — Auto-checkpoint BEFORE risky ops =====
      // Spec line 252: "Auto-checkpoint BEFORE risky ops (file_edit/file_delete/
      // file_multi_edit/git_commit/run_tests) in workflow-engine.ts executeTool
      // calls — wrap with try/finally".
      //
      // Strategy: if the tool being called is in RISKY_OPS, take a differential
      // Neo4j checkpoint + fs-checkpoint BEFORE calling executeTool. The checkpoint
      // is fire-and-forget (errors swallowed) so a checkpoint failure never blocks
      // the actual operation.
      if (RISKY_OPS.has(tc.name)) {
        try {
          // 1. Neo4j differential checkpoint (Neo4j graph state)
          await autoCheckpointBeforeRiskyOp({
            sessionId,
            operation: tc.name as 'file_edit' | 'file_delete' | 'file_multi_edit' | 'git_commit' | 'run_tests',
            targetFiles: Array.isArray(tc.args?.paths) ? tc.args.paths.map(String) : undefined,
          })

          // 2. fs-checkpoint for the target files (filesystem state)
          //    Extract the file path from the tool args (varies per tool).
          const targetPaths: string[] = []
          const argPath = typeof tc.args?.path === 'string' ? tc.args.path
            : typeof tc.args?.filePath === 'string' ? tc.args.filePath
            : ''
          if (argPath) targetPaths.push(argPath)
          if (Array.isArray(tc.args?.edits)) {
            for (const e of tc.args.edits) {
              if (typeof e?.path === 'string') targetPaths.push(e.path)
            }
          }
          if (Array.isArray(tc.args?.paths)) {
            for (const p of tc.args.paths) {
              if (typeof p === 'string') targetPaths.push(p)
            }
          }
          if (targetPaths.length > 0) {
            const workspaceRoot = await getWorkspaceRoot()
            const fsc = getFsCheckpoint(workspaceRoot)
            await fsc.createCheckpoint({
              sessionId,
              label: `auto-before-${tc.name}`,
              filePaths: targetPaths,
            })
            console.log(`[Workflow] Phase 4.1 fs-checkpoint created (before ${tc.name}, ${targetPaths.length} file(s)) for session ${sessionId}`)
          }
        } catch (err) {
          // Never block the operation due to checkpoint failure
          console.warn(`[Workflow] Phase 4.1 auto-checkpoint FAILED (non-blocking): ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const toolResult = await executeTool(tc.name, tc.args)
      const toolDuration = Date.now() - toolStartTime

      toolCallsLog.push({
        tool: tc.name,
        args: tc.args,
        result: JSON.stringify(toolResult.result).slice(0, 500),
        duration: toolDuration,
        success: toolResult.success,
      })

      emit({
        type: 'tool_result',
        agent: agent.name,
        position,
        tool: tc.name,
        result: toolResult.success ? 'OK' : 'Error',
        detail: JSON.stringify(toolResult.result).slice(0, 500),
        duration: toolDuration,
      })

      // Add tool result to conversation
      messages.push({
        role: 'tool',
        content: JSON.stringify({
          tool: tc.name,
          success: toolResult.success,
          result: toolResult.result,
        }),
        tool_call_id: tc.id,
      })
    }

    // ===== v2.1 Phase 5.6 — Context overflow detection (Appendix C.4) =====
    // Strategy: after every tool iteration, estimate the conversation's
    // token count. If it exceeds CONTEXT_OVERFLOW_THRESHOLD (80k default)
    // AND ENABLE_SESSION_RESUME is on, build a WorkflowState snapshot,
    // pause the session (status='paused' + contextOverflowCount++), and
    // break the ReAct loop with a sentinel marker so the parent workflow
    // can detect the overflow and (in a later phase) call the resume
    // endpoint. For now the marker is logged + appended to finalContent;
    // auto-resume is a manual API call per spec ("DON'T wire the resume
    // side into the parent workflow auto-resume yet").
    const currentTokens = estimateTokens(messages)
    if (
      detectContextOverflow(currentTokens, CONTEXT_OVERFLOW_THRESHOLD) &&
      isFlagEnabled('ENABLE_SESSION_RESUME')
    ) {
      console.warn(`[Workflow] ${agent.name} (${position}) context overflow detected: ~${currentTokens} tokens > ${CONTEXT_OVERFLOW_THRESHOLD} threshold — pausing session ${sessionId} for resume handoff`)
      // Build the serialized state — keep the last 5 tool receipts to comply
      // with Appendix C.4 step 5 ("re-inject: ... last 5 tool receipts").
      const lastFiveReceipts = toolCallsLog.slice(-5).map((entry) => ({
        tool: entry.tool,
        args: entry.args,
        result: entry.result,
        timestamp: new Date().toISOString(),
      }))
      const overflowState: WorkflowState = {
        currentStep: `${agent.name} (${position}) — ${step}`,
        todoIds: [], // populated by the consumer from the Todo table at resume time
        lastToolReceipts: lastFiveReceipts,
        overflowTokenCount: currentTokens,
        overflowIteration: iterations,
      }
      // Persist the latest state BEFORE pausing so the resuming agent sees
      // the most recent tool receipts (save → pause, atomic order).
      try {
        await saveWorkflowSession(
          sessionId,
          position,
          step, // taskDescription placeholder — caller can update via save on next call
          overflowState,
          'active',
        )
        await pauseWorkflowSession(sessionId, 'context overflow')
      } catch (persistErr) {
        // Never crash the workflow because state persistence failed — log + continue.
        console.error(`[Workflow] Phase 5.6 state persist failed (non-blocking): ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`)
      }
      // Sentinel marker — parent workflow detects this and (Phase 5+ future)
      // auto-calls POST /api/workflow/resume?sessionId=<sessionId>.
      finalContent += `\n\n[CONTEXT_OVERFLOW:session=${sessionId}] Conversation reached ~${currentTokens} tokens (> ${CONTEXT_OVERFLOW_THRESHOLD} threshold). State persisted; call POST /api/workflow/resume?sessionId=${sessionId} to continue.`
      emit({
        type: 'error',
        agent: agent.name,
        position,
        message: `Context overflow (~${currentTokens} tokens) — session ${sessionId} paused for resume handoff`,
      })
      break
    }

    // If G2-B reached max iterations, break
    if (position === 'G2-B' && iterations >= maxIterations) {
      finalContent += `\n\n⚠️ Đạt max ${maxIterations} vòng iteration. Bugs còn lại ghi cho G3.`
      break
    }

    // If general max iterations reached, break
    if (iterations >= maxIterations) {
      console.warn(`[Workflow] ${agent.name} reached max iterations (${maxIterations})`)
      finalContent += `\n\n⚠️ Đạt max ${maxIterations} vòng iteration.`
      break
    }
  }

  // Log summary — includes Phase 1c dual-mode metrics for A/B validation
  const fcMetrics = fcMode === 'off'
    ? 'fc: off'
    : `fc: ${fcMode} (native=${nativeToolCallCount}, regex_fallback=${regexFallbackCount})`
  console.log(`[Workflow] ${agent.name} done: ${iterations} iterations, ${totalToolCalls} tool calls, ${Date.now() - stepStartTime}ms [${fcMetrics}]`)

  return { content: finalContent, duration: Date.now() - stepStartTime }
}

// ==================== CHECKPOINT VERIFY ====================

/**
 * Run TL checkpoint verification.
 *
 * Workflow doc: "READ-WRITE-VERIFY LOOP — TL là Agentic Loop Controller"
 * After each group completes, TL reads worklog and decides: CONTINUE / PIVOT / ESCALATE
 *
 * @returns Checkpoint decision with reasoning
 */
async function runTLCheckpointVerify(
  sessionId: string,
  spec: string,
  emit: SSEEmitter,
  ctx: WorkflowContext,
): Promise<{ decision: 'CONTINUE' | 'PIVOT' | 'ESCALATE'; reasoning: string; updatedSpec?: string }> {
  const worklogs = await readWorklog(sessionId)
  const latestWorklog = worklogs[worklogs.length - 1]

  if (!latestWorklog) {
    return { decision: 'CONTINUE', reasoning: 'No worklog to verify' }
  }

  // First, use rule-based verification from worklog.ts
  const ruleBasedDecision = verifyWorklog(latestWorklog, spec)

  // Then, ask TL to verify using LLM for nuanced decision
  const agentDef = ctx.resolvedAgentsCache.get('TL') || await resolveAgent('TL')

  emit({
    type: 'agent_start',
    agent: agentDef.name,
    position: 'TL',
    step: 'verify',
    avatar: agentDef.avatar,
  })

  const verifyPrompt = `Bạn là TL (APEX). Verify checkpoint sau ${latestWorklog.agentName} (${latestWorklog.position}).

━━━ SPEC GỐC ━━━
${spec.slice(0, 1000)}

━━━ WORKLOG TỪ ${latestWorklog.agentName} ━━━
Agent: ${latestWorklog.agentName} (${latestWorklog.position})
Step: ${latestWorklog.step}
Summary: ${latestWorklog.summary}
Completed: ${latestWorklog.completed.join(', ') || '(none)'}
Issues: ${latestWorklog.issues.length > 0 ? latestWorklog.issues.map(i => `[${i.severity}] ${i.type}: ${i.description}${i.fixApplied ? ' (FIXED)' : ''}`).join('; ') : '(none)'}
Suggestions: ${latestWorklog.suggestions.join('; ') || '(none)'}
Concerns: ${latestWorklog.concerns.join('; ') || '(none)'}
${latestWorklog.unfixedBugs && latestWorklog.unfixedBugs.length > 0 ? `Unfixed bugs: ${latestWorklog.unfixedBugs.map(b => `[${b.severity}] ${b.description} (${b.reason})`).join('; ')}` : ''}

━━━ QUYẾT ĐỊNH ━━━
Dựa trên worklog, quyết định:
- CONTINUE: Progress đúng kế hoạch, tiếp tục pipeline
- PIVOT: Direction cần thay đổi (approach sai, requirement mới)
- ESCALATE: Cần user input (blocker, ambiguous requirement)

Output JSON trong markdown code block:
\`\`\`json
{
  "decision": "CONTINUE|PIVOT|ESCALATE",
  "reasoning": "<lý do>",
  "updatedSpec": "<nếu PIVOT — spec mới, ngược lại null>",
  "issues": ["<vấn đề phát hiện>"]
}
\`\`\``

  // Build system prompt for TL checkpoint verify — include skills injection
  let verifySystemPrompt = getAgentPrompt('TL')
  if (ctx.skillsContext) {
    verifySystemPrompt += ctx.skillsContext
  }

  // Call LLM for checkpoint verification — with shorter timeout (30s)
  // Edge case #1: LLM timeout → fallback to rule-based decision
  const verifyCallPromise = callLLMForAgent(
    verifyPrompt,
    { provider: agentDef.provider, model: agentDef.model },
    verifySystemPrompt,
    { agentId: 'TL-verify', agentName: 'APEX' }
  )

  let verifyTimeoutId: ReturnType<typeof setTimeout> | undefined
  const verifyTimeoutPromise = new Promise<LLMResult>((_resolve, reject) => {
    verifyTimeoutId = setTimeout(() => reject(new Error(`Checkpoint verify LLM call timed out after ${CHECKPOINT_VERIFY_TIMEOUT_MS}ms`)), CHECKPOINT_VERIFY_TIMEOUT_MS)
  })

  let result: LLMResult
  try {
    result = await Promise.race([verifyCallPromise, verifyTimeoutPromise])
  } catch (timeoutErr) {
    // Always clear timeout to prevent resource leak
    if (verifyTimeoutId) clearTimeout(verifyTimeoutId)
    // Checkpoint verify timed out — fallback to rule-based decision
    const timeoutMsg = timeoutErr instanceof Error ? timeoutErr.message : 'Checkpoint verify timed out'
    console.warn(`[Workflow] TL checkpoint verify LLM timeout: ${timeoutMsg} — using rule-based decision: ${ruleBasedDecision}`)
    emit({
      type: 'error',
      agent: agentDef.name,
      position: 'TL',
      step: 'verify',
      message: timeoutMsg,
    })
    return {
      decision: ruleBasedDecision,
      reasoning: `LLM verify timed out (${timeoutMsg}). Rule-based decision: ${ruleBasedDecision}.`,
    }
  } finally {
    // Clear timeout on success to prevent resource leak
    if (verifyTimeoutId) clearTimeout(verifyTimeoutId)
  }

  // Parse TL verify decision
  const parsed = parseVerifyDecision(result.content)

  emit({
    type: 'agent_complete',
    agent: agentDef.name,
    position: 'TL',
    step: 'verify',
    content: result.content,
    duration: 0,
  })

  return {
    decision: parsed?.decision || ruleBasedDecision,
    reasoning: parsed?.reasoning || `Auto-verify: ${ruleBasedDecision} based on worklog issues`,
    updatedSpec: parsed?.updatedSpec,
  }
}

// ==================== HELPERS ====================

/**
 * Build the initial prompt for TL's routing analysis.
 * Includes chat history + current request.
 */
function buildTLPrompt(userRequest: string, messages: Array<{ role: string; content: string }>): string {
  // Include last 10 messages for context
  const history = messages
    .slice(-10)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')

  return `Chat history:\n${history}\n\nYêu cầu hiện tại: ${userRequest}\n\nPhân tích routing decision. Output JSON trong markdown code block với format:\n\`\`\`json\n{\n  "mode": "A|B|C",\n  "tier": 1|2|3,\n  "score": <3-9>,\n  "reasoning": "<giải thích>",\n  "parts": [\n    { "name": "<tên part>", "type": "visual|backend", "description": "<mô tả>", "dependency": [] }\n  ],\n  "spec": "<chi tiết spec cho từng part>"\n}\n\`\`\``
}

/**
 * Parse routing decision from TL's LLM output.
 * Extracts JSON from markdown code blocks.
 */
function parseRoutingDecision(output: string): RoutingDecision | null {
  try {
    // Strategy 1: Find JSON in markdown code block
    const jsonMatch = output.match(/```json\s*([\s\S]*?)```/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1])
      if (parsed.mode && parsed.tier && parsed.score !== undefined) {
        return {
          mode: ['A', 'B', 'C'].includes(parsed.mode) ? parsed.mode : 'B',
          tier: [1, 2, 3].includes(parsed.tier) ? parsed.tier : 2,
          score: typeof parsed.score === 'number' ? Math.min(9, Math.max(3, parsed.score)) : 5,
          reasoning: parsed.reasoning || '',
          parts: Array.isArray(parsed.parts)
            ? parsed.parts.map((p: Record<string, unknown>) => ({
                name: String(p.name || 'main'),
                type: (p.type === 'visual' ? 'visual' : 'backend') as 'visual' | 'backend',
                description: String(p.description || ''),
                dependency: Array.isArray(p.dependency) ? p.dependency.map(String) : [],
              }))
            : [{ name: 'main', type: 'backend' as const, description: 'Main task', dependency: [] }],
          spec: parsed.spec || '',
        }
      }
    }

    // Strategy 2: Try to find raw JSON object
    const rawMatch = findBalancedJsonUtil(output, '"mode"')
    if (rawMatch) {
      const parsed = JSON.parse(rawMatch)
      if (parsed.mode && parsed.tier) {
        return {
          mode: ['A', 'B', 'C'].includes(parsed.mode) ? parsed.mode : 'B',
          tier: [1, 2, 3].includes(parsed.tier) ? parsed.tier : 2,
          score: typeof parsed.score === 'number' ? Math.min(9, Math.max(3, parsed.score)) : 5,
          reasoning: parsed.reasoning || '',
          parts: Array.isArray(parsed.parts)
            ? parsed.parts.map((p: Record<string, unknown>) => ({
                name: String(p.name || 'main'),
                type: (p.type === 'visual' ? 'visual' : 'backend') as 'visual' | 'backend',
                description: String(p.description || ''),
                dependency: Array.isArray(p.dependency) ? p.dependency.map(String) : [],
              }))
            : [{ name: 'main', type: 'backend' as const, description: 'Main task', dependency: [] }],
          spec: parsed.spec || '',
        }
      }
    }
  } catch (err) {
    console.warn('[Workflow] Failed to parse routing decision:', err)
  }

  return null
}

/**
 * Parse verify decision from TL's checkpoint verify output.
 */
function parseVerifyDecision(
  output: string
): { decision: 'CONTINUE' | 'PIVOT' | 'ESCALATE'; reasoning: string; updatedSpec?: string } | null {
  try {
    const jsonMatch = output.match(/```json\s*([\s\S]*?)```/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1])
      const validDecisions = ['CONTINUE', 'PIVOT', 'ESCALATE']
      if (parsed.decision && validDecisions.includes(parsed.decision)) {
        return {
          decision: parsed.decision,
          reasoning: parsed.reasoning || '',
          updatedSpec: parsed.updatedSpec || undefined,
        }
      }
    }

    // Fallback: look for decision keywords in text
    const lowerOutput = output.toLowerCase()
    if (lowerOutput.includes('escalate')) {
      return { decision: 'ESCALATE', reasoning: 'ESCALATE keyword found in TL output' }
    }
    if (lowerOutput.includes('pivot')) {
      return { decision: 'PIVOT', reasoning: 'PIVOT keyword found in TL output' }
    }
  } catch {}

  return null
}

/**
 * Parse tool calls from LLM output text.
 *
 * Since callLLMForAgent doesn't natively support function calling response format,
 * we parse tool calls from the text output using the format that agents are instructed to use.
 *
 * Supported formats:
 * 1. tool_call: function_name({args})
 * 2. opencode({action: "read", path: "..."})
 */
function parseToolCallsFromOutput(output: string): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const calls: Array<{ id: string; name: string; args: Record<string, unknown> }> = []

  // Pattern 1: tool_call: function_name({...})
  // Use findBalancedJson for nested JSON args (e.g., opencode write with content containing code)
  const regex1 = /tool_call:\s*(\w+)\s*\(\s*\{/g
  let match1
  while ((match1 = regex1.exec(output)) !== null) {
    const toolName = match1[1]
    // Find the opening brace position and extract balanced JSON
    const braceStart = output.indexOf('{', match1.index + match1[0].length - 1)
    if (braceStart === -1) continue
    const jsonStr = findBalancedJsonUtil(output.slice(braceStart), '')
    if (jsonStr) {
      try {
        const args = JSON.parse(jsonStr)
        calls.push({
          id: `tc_${Date.now()}_${calls.length}`,
          name: toolName,
          args,
        })
      } catch {
        // JSON parse failed, skip this tool call
      }
    }
  }

  // Pattern 2: Direct tool invocation like opencode({...})
  if (calls.length === 0) {
    const validToolNames = ['opencode', 'knowledge_search', 'knowledge_graph', 'knowledge_write', 'tavily', 'serper', 'jina', 'file_edit', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'browser_screenshot', 'lint', 'type_check', 'test_coverage', 'db_query', 'mcp_call', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview']
    const regex2 = new RegExp(`(${validToolNames.join('|')})\\s*\\(\\s*\\{`, 'g')
    let match2
    while ((match2 = regex2.exec(output)) !== null) {
      const toolName = match2[1]
      const braceStart = output.indexOf('{', match2.index + match2[0].length - 1)
      if (braceStart === -1) continue
      const jsonStr = findBalancedJsonUtil(output.slice(braceStart), '')
      if (jsonStr) {
        try {
          const args = JSON.parse(jsonStr)
          calls.push({
            id: `tc_${Date.now()}_${calls.length}`,
            name: toolName,
            args,
          })
        } catch {
          // JSON parse failed
        }
      }
    }
  }

  return calls
}

/**
 * Format conversation messages into a single prompt string for callLLMForAgent.
 * callLLMForAgent takes a single prompt, not a messages array.
 */
function formatMessagesForLLM(
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string
    tool_call_id?: string
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  }>
): string {
  let prompt = ''

  for (const msg of messages) {
    switch (msg.role) {
      case 'system':
        // System prompt is handled separately by callLLMForAgent
        break
      case 'user':
        prompt += `\n\n[USER]: ${msg.content}`
        break
      case 'assistant':
        prompt += `\n\n[ASSISTANT]: ${msg.content}`
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          prompt += `\nTool calls: ${msg.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments})`).join(', ')}`
        }
        break
      case 'tool':
        prompt += `\n\n[TOOL RESULT]: ${msg.content}`
        break
    }
  }

  return prompt.trim()
}

// ==================== v2.1 Phase 5.1 — Helpers for master-orchestrator wiring ====================
//
// Spec: docs/FULLSTACK_CAPABILITY_PLAN_V2.md Phase 5.1 (lines 305-314)
//       master-orchestrator.ts executeStep() needs to call runAgentStep() —
//       but runAgentStep requires a WorkflowContext + SSEEmitter, both of which
//       are normally constructed inside runWorkflow() and not exposed.
//
// These helpers let master-orchestrator construct minimal versions:
//   - createMinimalWorkflowContext: builds an empty ctx (no resolved agents cache,
//     no skills injection) — agents are resolved on-demand inside runAgentStep.
//   - noopSSEEmitter: a no-op emit function that silently drops SSE events —
//     suitable when the orchestrator is run outside of a workflow UI stream.
//
// Both are exported alongside runAgentStep so orchestration can dispatch real
// agent steps without spinning up a full workflow run.

/**
 * Build a minimal WorkflowContext for use outside of runWorkflow (e.g. when
 * master-orchestrator.executeStep dispatches a single agent step in isolation).
 *
 * - resolvedAgentsCache starts empty; runAgentStep will lazy-resolve on first call.
 * - skillsContext is loaded once (best-effort, swallow errors). Pass `skipSkills: true`
 *   to skip the DB query entirely (useful for smoke tests or background tasks).
 */
export async function createMinimalWorkflowContext(opts?: {
  skipSkills?: boolean
}): Promise<WorkflowContext> {
  const ctx: WorkflowContext = {
    resolvedAgentsCache: new Map(),
  }
  if (!opts?.skipSkills) {
    try {
      ctx.skillsContext = await loadEnabledSkills()
    } catch {
      // Never break orchestration because skills injection fails
      ctx.skillsContext = ''
    }
  }
  return ctx
}

/**
 * Return a no-op SSEEmitter that silently drops all events.
 * Use when running agent steps outside of a UI-bound workflow stream (e.g.
 * master-orchestrator.executeStep in isolation, smoke tests, background tasks).
 */
export function noopSSEEmitter(): SSEEmitter {
  return (_event: WorkflowEvent) => {
    // Intentionally empty — drop the event silently
  }
}
