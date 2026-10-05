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
import { getToolDefinitions } from './tool-executor'
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
} from './worklog'
// FIX 2026-08-29: import pure utility trực tiếp (không qua worklog) để giảm coupling
import { findBalancedJson as findBalancedJsonUtil } from './find-balanced-json'
// TASK 43 — strict-parse: parser bản địa dùng chung lớp loose-repair với
// tool-calls.ts (escape control chars trong string + strip trailing comma
// string-aware) — trước đây JSON.parse thuần fail → tool call bị BỎ QUA im lặng.
import { tryParseLooseJson } from '@/lib/tool-calls'
import {
  executeTool,
} from './tool-executor'
// Agent Run Tracker — Thought Process + Todos + Progress trong chat (user request 2026-08-31)
import { startAgentRun, endAgentRun, recordAgentThought, recordAgentRunTodos, isSessionCancelled } from '@/lib/agent-run-tracker'
import { flagMode, isFlagEnabled } from '@/lib/feature-flags'
// Phase 6/7 (rebuild) — workspace root follows the USER's ACTIVE workspace
import { resolveWorkspaceRoot } from './workspace-root'
// TASK 41 — abs path server-resolved cho tool_call/tool_result SSE event (UI
// auto-open file đúng workspace root thật của server — xem dev-tools.resolveUiAbsPath)
import { resolveUiAbsPath } from './dev-tools'
// 2026-08-29 — Team Code agents cũng cần biết workspace root + cấu trúc cấp 1
// (user request: mọi agents + team code đều nắm được thư mục đã chọn).
import { buildWorkspaceContext } from '@/lib/workspace/workspace-context'
// CI-3 B7 (Task 13-e) — system prompt per-step có budget ký tự TỔNG
// (SYSTEM_PROMPT_BUDGET_CHARS mặc định 24k): các block góp vào prompt của step
// (persona/skills/workspace/capabilities/roster/layer9-hints/tool-schemas)
// ngoài skills 16k không block nào cap → vượt budget thì cắt priority thấp nhất giữ đầu.
import { budgetPromptWith, type PromptBlock } from '@/lib/prompt-budget'
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
  getSessionMetadata,
  pauseWorkflowSession,
  performSessionResume,
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
import { createMetricsCollector, analyzeHistoricalFeedback, getAdjustedBudget, getSuccessProbability, type MetricsCollector } from '@/lib/learning'
// CI-3 B1 (Task 13-a) — nén context dùng chung với goal-loop: cap tool result
// 4k chars + rolling digest 50k chars (roadmap CI-3 "Lỗ hổng 1": workflow push
// tool result THÔ không giới hạn → task code dài phình đến 80k tokens rồi pause).
import {
  COMPRESS_THRESHOLD_CHARS,
  KEEP_RECENT_MESSAGES,
  TOOL_RESULT_MAX_CHARS,
  compressConversation,
  truncateToolMessageJson,
  type CompressionMessage,
  type CompressionResult,
} from '@/lib/context-compression'

/** Operations that trigger auto-checkpoint BEFORE they execute. */
const RISKY_OPS = new Set<string>([
  'file_edit', 'file_delete', 'file_multi_edit', 'git_commit', 'run_tests',
])

/** FIX (review R2-c #1, 2026-08-31) — DEPTH GUARD cho ReAct loop workflow.
 * Vấn đề: ReAct loop thực thi MỌI tool name LLM phát ra (kể cả text tool-call
 * regex parse khi ENABLE_NATIVE_FC=dual) KHÔNG qua whitelist — agent trong team
 * hallucinate 'request_code_team'/'delegate_task' → workflow LỒNG workflow /
 * sub-agent trong team → RAM + token chồng tầng, abort ngoài không lan vào trong.
 * Giờ: các tool huy động (delegation/team) bị TỪ CHỐI tại executor của workflow
 * — agent tự làm step bằng tools thi công. (Mirror DEPTH_GUARD_TOOLS của
 * subagent-delegate.ts — copy local để tránh circular import.) */
const WF_DEPTH_GUARD_TOOLS = new Set<string>([
  'delegate_task', 'dispatch_agent', 'dispatch_agents_parallel', 'create_agent', 'request_code_team',
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
 *  and the workflow continues to the next pipeline step (graceful degradation).
 *
 *  CI-5 B6 (Task 14-d): 4 phút → 8 phút (env-controlled) — roadmap Phụ lục A:
 *  lượt suy luận/biến đổi lớn (TL recon 30K-token context) bị cắt giữa chừng
 *  ở 4'. Đọc 1 LẦN module-level theo pattern env của file — đổi giá trị cần
 *  restart app. KHÔNG đụng: GOAL_LOOP_LLM_TIMEOUT_MS của agent-goal-loop.ts
 *  (goal-loop có timeout riêng 21') và CHECKPOINT_VERIFY_TIMEOUT_MS bên dưới
 *  (TL verify là quyết định ngắn — giữ 30s). Exported cho smoke test (14-d). */
export const AGENT_STEP_TIMEOUT_MS =
  Math.max(1_000, parseInt(process.env.AGENT_STEP_TIMEOUT_MS || '600000', 10) || 600_000) // 10 phút per LLM call — Task 20 (2026-09-03) nâng từ 480s: worst-case chuỗi fallback khi 3 lõi đầu hang NIM = ~460s (3 × 150s timeout + minimax ~5s) — 480s cũ chỉ chừa 20s margin; 600s chừa dư dả. Prober (llm.ts) trip breaker cho lõi hang nên step thường trở lại ~giây. REVIEW 14-g L1: Math.max chống giá trị âm/0 ('-5' truthy → setTimeout âm = timeout tức thì mọi call)

/** Shorter timeout for TL checkpoint verification calls — these are brief decisions, not long code generation. */
const CHECKPOINT_VERIFY_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.CHECKPOINT_VERIFY_TIMEOUT_MS || '300000', 10) || 300_000) // Task 20 (2026-09-03): 30s → 300s — TL verify chạy trên kimi-k3 (reasoning, có khi >120s trong pha suy luận) + khi 3 lõi đầu hang NIM cần ~460s mới tới minimax; 30s cũ gần như LUÔN timeout → rơi rule-based. 300s + fallback rule-based giữ nguyên (fail-open).

/** CI-5 B6 (Task 14-d) — RETRY LLM call transient trong 1 iteration của ReAct
 *  loop của step: tối đa 2 lần retry (tổng 3 attempts), backoff 5s → 15s
 *  (hardcode hợp lý theo đề bài — không env). Chỉ retry lỗi TRANSIENT hạ tầng
 *  (isTransientLlmError) — chi tiết khối retry trong runAgentStep. */
const WORKFLOW_STEP_LLM_MAX_RETRIES = 2
const WORKFLOW_STEP_LLM_RETRY_DELAYS_MS = [5_000, 15_000]

// v2.1 Phase 5.6 — Context overflow threshold (Appendix C.4 step 1).
// 80k tokens triggers a session pause + resume handoff so a new agent can
// re-inject the original task + last 5 tool receipts + current step.
// Configurable via CONTEXT_OVERFLOW_THRESHOLD env var.
const CONTEXT_OVERFLOW_THRESHOLD =
  parseInt(process.env.CONTEXT_OVERFLOW_THRESHOLD || '80000', 10) || 80000

// ━━━ CI-3 B5 (Task 13-d) — AUTO-RESUME GUARD ━━━
// Overflow pause sau digest thất bại sẽ KHÔNG treo vĩnh viễn: workflow tự
// resume session in-process (cùng code path POST /api/workflow/resume).
// Guard chống loop vĩnh viễn nén→pause→resume→nén: tối đa N lần auto-resume
// mỗi session (đếm contextOverflowCount — vượt N → pause THẬT chờ can thiệp
// thủ công). Configurable qua WORKFLOW_MAX_AUTO_RESUME.
const MAX_AUTO_RESUME_PER_SESSION =
  parseInt(process.env.WORKFLOW_MAX_AUTO_RESUME || '3', 10) || 3

// Độ trễ trước khi auto-resume kích hoạt (ms). Ngắn — chỉ để pause
// transaction + break ReAct loop yên vị; KHÔNG block step (fire-and-forget).
// Configurable qua WORKFLOW_AUTO_RESUME_DELAY_MS.
const AUTO_RESUME_DELAY_MS =
  parseInt(process.env.WORKFLOW_AUTO_RESUME_DELAY_MS || '2000', 10) || 2000

// ━━━ FIX 2026-09-15 #3 (P2 — audit Team Code) — TOOL-FAILURE THRESHOLD ━━━
// Số tool fail LIÊN TIẾP trong 1 ReAct step trước khi auto-consult Omega.
// Trước đây tool fail chỉ được đẩy vào conversation — KHÔNG counter/threshold/
// guard nào → agent quay vòng thất bại đến cạn maxIterations (audit Team Code
// 2026-09-15: "tool fail → đẩy vào conversation, KHÔNG có counter/threshold/guard").
const WF_TOOL_FAIL_ESCALATE_THRESHOLD =
  parseInt(process.env.WF_TOOL_FAIL_ESCALATE_THRESHOLD || '3', 10) || 3


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
    | 'clarification_resolved'
    | 'workflow_done'
    | 'omega_escalation'
    | 'error'
    /** ROUND-37 V4 — Layer 8 progress-reporter sống lại: báo cáo tiến độ
     * mỗi step (formattedReport từ communication/progress-reporter) */
    | 'progress_report'
    /** ROUND-37 V4 — báo cáo tổng kết cuối workflow (formatFinalReport) */
    | 'final_report'
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
  /**
   * 2026-10-27 (rà soát Task 27-a — trần prompt THEO TÁC VỤ cho cả chuỗi
   * delegation): budget override từ run cha truyền qua request_code_team.
   * -1 = KHÔNG GIỚI HẠN (PROMPT ∞); undefined = mặc định hệ thống.
   */
  promptBudgetChars?: number
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
interface RawSkill { name: string; slug: string; content: string }

/** Query DB skills enabled — raw (chưa render) để lọc per-agent sau. */
async function loadEnabledSkillsRaw(): Promise<RawSkill[]> {
  try {
    return await db.agentSkill.findMany({
      where: { enabled: true },
      select: { name: true, slug: true, content: true },
    })
  } catch {
    return [] // Never break workflow if DB is unavailable
  }
}

/** Render skills thành block prompt (budget ~16k chars) — format cũ giữ nguyên. */
function renderSkillsText(skills: RawSkill[]): string {
  if (skills.length === 0) return ''
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
}

async function loadEnabledSkills(): Promise<string> {
  return renderSkillsText(await loadEnabledSkillsRaw())
}

/** 2026-09-01 — SKILL ACCESS prompt-side: lọc skill bị chặn cho 1 agent rồi
 *  render. Fail-open trả full text (lỗi DB không bỏ skills). */
async function loadEnabledSkillsForAgent(agentName: string | null | undefined, raw: RawSkill[]): Promise<string> {
  if (raw.length === 0) return ''
  try {
    const { getDisabledSlugsForAgent } = await import('@/lib/skill-access')
    const disabled = await getDisabledSlugsForAgent(agentName)
    if (disabled.size > 0) {
      const filtered = raw.filter(s => !disabled.has(s.slug))
      return renderSkillsText(filtered)
    }
  } catch { /* fail-open */ }
  return renderSkillsText(raw)
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
  /** 2026-09-01 — raw DB skills (kèm slug) — dùng lọc per-agent theo SkillAssignment
   *  rồi render riêng cho từng agent step (skillsContext vẫn dùng cho fallback) */
  skillsRaw?: RawSkill[]
  /** Task 17-b (Layer 9): số hint "bài học từ thất bại trước" đã inject trong run — dùng cho observation log khi workflow thành công */
  layer9HintsInjected?: number
  /** ROUND-37 V3.1: số lesson episodic đã inject qua PRE-ACT trong run */
  episodicBrainInjected?: number
  /** 2026-10-27 (rà soát Task 27-a): trần prompt theo tác vụ từ run cha
   * (request_code_team) — -1 = unlimited; undefined = mặc định hệ thống */
  promptBudgetChars?: number
}

// ==================== LAYER 9 P1.2 + P1.3 — ERROR TAXONOMY & PATTERN PERSISTENCE ====================

/**
 * Layer 9 P1.2 (2026-08-25) — Phân loại lỗi workflow: transient vs systematic.
 *
 * Trước P1.2: mọi lỗi hardcode errorType='runtime' → detectFailurePattern
 * tính 2 lỗi bất kỳ cùng type = "repeated_error" → khuyến nghị đổi approach
 * sai (2 lỗi mạng không liên quan cũng đếm là "lặp"). Phân loại:
 *   - transient_*: tự hồi phục (retry là đúng đắn) — mạng, 429, 5xx, timeout
 *   - systematic_*: cần đổi cách làm — tool từ chối, parse lỗi, logic sai
 *   - runtime: không phân loại được (fallback an toàn)
 */
function classifyWorkflowError(errorMessage: string): import('@/lib/error-handling/types').ErrorType {
  const msg = errorMessage.toLowerCase()
  // Transient: network / rate-limit / server errors — retry-able
  if (/timeout|timed out|econnreset|econnrefused|enotfound|fetch failed|network/.test(msg)) return 'transient_network'
  if (/429|rate.?limit|too many requests|quota/.test(msg)) return 'transient_ratelimit'
  if (/503|502|500|service unavailable|bad gateway|internal server/.test(msg)) return 'transient_server'
  // Systematic: cần đổi approach
  if (/tool .*(not found|not allowed|refused|rejected)|invalid tool|unknown tool/.test(msg)) return 'systematic_tool_rejected'
  if (/parse|json|syntax|malformed|invalid format/.test(msg)) return 'systematic_parse'
  if (/permission|denied|unauthorized|forbidden|401|403/.test(msg)) return 'systematic_permission'
  if (/not found|does not exist|no such file|missing/.test(msg)) return 'systematic_notfound'
  return 'runtime' // không phân loại được — giữ type cũ làm fallback
}

/**
 * CI-5 B6 (Task 14-d) — phân loại lỗi LLM call của step có đáng retry hay không.
 * TRANSIENT = lỗi hạ tầng TỰ HỒI PHỤC, tái dùng đúng taxonomy transient_* của
 * classifyWorkflowError ở trên (network/timeout — 429/rate-limit — 5xx), cộng
 * thêm tổng kết "CẢ chuỗi lõi agent đều thất bại sau N sweep" của
 * callAgentModelWithFallbackChain (llm.ts) — nguyên nhân rễ của message này là
 * các attempt 429/5xx/timeout/network đã burn hết sweep bên trong chuỗi (key
 * chết auth/quota bị loại sớm khỏi chuỗi) → retry outer là đúng đắn.
 * KHÔNG transient: auth/permission (401/403 — key sai, retry vô nghĩa), user
 * abort, tool rejected, parse error (systematic_*) — và TUYỆT ĐỐI không retry
 * khi agent trả lời HỢP LỆ nhưng content "fail" theo domain (đó là quyết định
 * của agent, không phải lỗi hạ tầng — response như vậy có content/tool_calls
 * và được dùng thẳng, không bao giờ rơi vào classifier này).
 * Exported cho smoke test (14-d) — không đổi hành vi của caller hiện có.
 */
export function isTransientLlmError(message: string): boolean {
  try {
    const cls = classifyWorkflowError(message)
    if (
      cls === 'transient_network' ||
      cls === 'transient_ratelimit' ||
      cls === 'transient_server'
    ) {
      return true
    }
    return (
      /cả chuỗi lõi agent đều thất bại/i.test(message) ||
      // Mã lỗi mạng Node/Bun mà taxonomy P1.2 bỏ sót ("ETIMEDOUT" không chứa
      // chuỗi con "timeout"/"timed out" nguyên vẹn)
      /etimedout|eai_again|epipe|socket hang up/i.test(message)
    )
  } catch {
    return false // fail-safe: không phân loại được → coi như không transient
  }
}

/**
 * Layer 9 P1.3 (2026-08-25) — Kẹp đoạn [4] của vòng Layer 9 trong production path.
 *
 * detectFailurePattern + persistFailurePattern + persistAdaptationLog từng chỉ
 * được import (không gọi) trong master-orchestrator phantom path — FailurePattern
 * table 0 rows vĩnh viễn. Helper này chạy mỗi khi 1 step fail trong runWorkflow:
 *
 *   1. detectFailurePattern(tổng hợp errors trong SESSION+STEP này — scoping theo
 *      stepId để 2 step khác nhau fail cùng lúc không bị tính "repeated")
 *   2. persistFailurePattern — upsert-increment (mỗi lần fail = +1 count)
 *   3. Pattern repeated_error (count >= 2, NGƯỠNG SAU taxonomy P1.2 — chỉ đếm
 *      error type systematic_x hoặc runtime, transient tự hồi) → persistAdaptationLog
 *      ghi nhận "cần đổi approach" (log thôi, chưa auto-apply — chờ đủ data)
 *
 * FIX (dead-end end-to-end): trước đây gọi detectFailurePattern với
 * previousErrors=[] + metrics toàn 0 → LUÔN trả null → `if (!pattern) return`
 * → KHÔNG persist gì → FailurePattern mãi 0 rows → getFailureHintsForAgent
 * (count>=2) LUÔN rỗng. Giờ: (a) lịch sử lỗi per (session,step) tích lũy
 * in-memory làm previousErrors; (b) metrics token thật truyền xuống để
 * resource_limit detector sống; (c) lần fail ĐẦU TIÊN vẫn persist seed row
 * count=1 (upsert bên trong cộng dồn khi lặp lại).
 *
 * Fire-and-forget từ call site; bên trong cũng tự catch toàn bộ.
 */
const sessionStepErrorHistory = new Map<string, Array<{ type: string; message: string }>>()

async function detectAndPersistFailurePattern(
  sessionId: string,
  stepId: string,
  errorMessage: string,
  metrics?: { totalTokensUsed: number; totalTokensBudgeted: number; totalTimeSpent: number }
): Promise<void> {
  const { detectFailurePattern, recommendAdaptation, persistFailurePattern, persistAdaptationLog } = await import('@/lib/learning')
  try {
    const errorType = classifyWorkflowError(errorMessage)

    // Tích lũy lịch sử lỗi per (session, step) — cap 30 entry chống phình
    const key = `${sessionId}::${stepId}`
    const history = sessionStepErrorHistory.get(key) ?? []
    history.push({ type: errorType, message: errorMessage.slice(0, 300) })
    sessionStepErrorHistory.set(key, history.slice(-30))

    // R7-M2 (S3, audit R7-M1): cap số KEY (session::step) 200 — value đã cap
    // 30 entry sẵn nhưng KEY không bao giờ bị delete → Map mọc vô hạn theo số
    // session+step. FIFO xóa key cũ nhất (insertion order của Map). Fail-open.
    while (sessionStepErrorHistory.size > 200) {
      const oldestKey = sessionStepErrorHistory.keys().next().value
      if (oldestKey === undefined) break
      sessionStepErrorHistory.delete(oldestKey)
    }

    // Pattern detection trên CHÍNH session+step này (đúng scoping P1.2: lỗi
    // giữa các step khác nhau không bị tính "repeated" — previousErrors là
    // history trừ lỗi hiện tại vì detect tự cộng currentError vào)
    const pattern = detectFailurePattern(
      { type: errorType, message: errorMessage.slice(0, 300) },
      history.slice(0, -1),
      metrics ?? { totalTokensUsed: 0, totalTokensBudgeted: 0, totalTimeSpent: 0 },
      null // historicalMetrics — có thể wired sau khi P1.1 cache sẵn
    )

    // Pattern để persist: detect được → dùng nguyên; KHÔNG detect được
    // (lần fail đầu) → seed row count=1 để upsert-increment cộng dồn sau
    const toPersist =
      pattern ??
      ({
        id: `pattern-${Date.now()}`,
        type: 'repeated_error',
        count: 1,
        lastOccurrence: new Date().toISOString(),
        strategiesTried: [],
        nextStrategy: 'change_fix_approach',
        context: { taskType: 'code-team-workflow', routingMode: 'unknown', stepType: stepId },
      } as NonNullable<typeof pattern>)

    const newCount = await persistFailurePattern({
      ...toPersist,
      context: {
        ...toPersist.context,
        taskType: 'code-team-workflow',
        routingMode: 'unknown',
        stepType: stepId,
        sessionId,
        errorType,
      } as typeof toPersist.context,
    })

    // P1.3: khuyến nghị adaptation khi pattern lặp đủ ngưỡng (count>=2 từ
    // DB — sống sót qua restart, tin được hơn in-memory)
    if (newCount >= 2) {
      const decision = recommendAdaptation(toPersist, null)
      await persistAdaptationLog({
        id: `adapt-${sessionId}-${Date.now()}`,
        sessionId,
        patternId: null, // upsert-increment: không track pattern id riêng
        fromStrategy: toPersist.nextStrategy,
        toStrategy: decision.recommendedStrategy,
        reason: decision.reason,
        confidence: decision.confidence,
        successful: null, // pending — markSessionAdaptationOutcome đóng vòng sau step kế
        createdAt: new Date().toISOString(),
      })
      // ROUND-37 V2a — APPLY THẬT (trước đây chỉ log rồi quên): 8 chiến lược
      // của applyAdaptation giờ tiêu thụ bởi runAgentStep của step kế tiếp —
      // directive system prompt (preStep/fixStrategy), giảm vòng (reduce_scope),
      // nén sớm (compress_context), escalate SSE (escalate_to_user), siết KB
      // threshold (tighten_refusal_threshold — TTL 24h tự hoàn tác).
      const { applyAdaptationToSession } = await import('@/lib/learning/adaptation-engine')
      const applied = applyAdaptationToSession(sessionId, decision, stepId)
      console.log(
        `[Workflow] Layer 9 P1.3→V2a — pattern persisted + adaptation ${applied ? 'APPLIED' : 'recommend-only'}: ${toPersist.type} count=${newCount} → ${decision.recommendedStrategy} (session ${sessionId.slice(0, 12)})`,
      )
    } else {
      console.log(`[Workflow] Layer 9 P1.3 — failure pattern persisted: ${toPersist.type} (count=${newCount}, errorType=${errorType}, session ${sessionId.slice(0, 12)})`)
    }
  } catch (err) {
    // persistFailurePattern đã tự catch bên trong — chỉ log thêm tầng này
    console.warn('[Workflow] Layer 9 P1.3 — detect/persist threw (non-fatal):', err instanceof Error ? err.message : String(err))
  }
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
    // 2026-10-27 (rà soát Task 27-a): trần prompt THEO TÁC VỤ của run cha
    promptBudgetChars: config?.promptBudgetChars,
  }

  // Load enabled skills once for the entire workflow run — cached in ctx.skillsContext
  // 2026-09-01: giữ cả raw (kèm slug) để render per-agent theo SkillAssignment
  ctx.skillsRaw = await loadEnabledSkillsRaw()
  ctx.skillsContext = renderSkillsText(ctx.skillsRaw)

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
  // ━━━ Layer 9 P1.1 (2026-08-25) — KẾP VÒNG [5]: history → quyết định hiện tại ━━━
  // Trước P1.1, budget 100000 là placeholder cố định — analyzeHistoricalFeedback
  // / getAdjustedBudget / getSuccessProbability tồn tại nhưng 0 caller (vòng
  // lặp đứt ở đoạn cuối). Giờ đầu mỗi workflow:
  //   1. Đọc aggregated history (cached 5 phút trong module scope)
  //   2. Adjusted budget = getAdjustedBudget (clamped [0.5×, 2×] base — chống
  //      spiral throttle: budget giảm → fail nhiều → budget giảm nữa)
  //   3. Success probability log ra — dùng sau bởi strategy decisions
  // Fail-open: history read lỗi → dùng base budget, workflow KHÔNG BAO GIỜ
  // bị block bởi learning layer (metrics/learning là side-channel, không phải
  // critical path).
  const BASE_TOKEN_BUDGET = 100000
  let effectiveTokenBudget = BASE_TOKEN_BUDGET
  let historicalMetrics: import('@/lib/learning').AggregatedMetrics | null = null
  try {
    historicalMetrics = await analyzeHistoricalFeedback()
    if (historicalMetrics && historicalMetrics.totalRuns > 0) {
      const routingMode = request.routing?.mode ?? 'A'
      const tier = request.routing?.tier ?? 1
      // getAdjustedBudget trả base × complexity khi chưa đủ data (minRuns 5)
      const adjusted = getAdjustedBudget(
        `mode-${routingMode}-tier-${tier}`,
        tier,
        historicalMetrics,
        BASE_TOKEN_BUDGET
      )
      // P1.1 anti-spiral clamp: history có thể sai (n=5, non-stationary) —
      // không cho budget lệch quá 2× hoặc dưới 0.5× base trong 1 bước nhảy.
      effectiveTokenBudget = Math.round(
        Math.min(BASE_TOKEN_BUDGET * 2, Math.max(BASE_TOKEN_BUDGET * 0.5, adjusted))
      )
      const successProb = getSuccessProbability(
        `mode-${routingMode}-tier-${tier}`,
        routingMode,
        historicalMetrics
      )
      console.log(`[Workflow] Layer 9 P1.1 — historical feedback: ${historicalMetrics.totalRuns} prior runs, budget ${BASE_TOKEN_BUDGET} → ${effectiveTokenBudget} (clamped), successProb=${successProb.toFixed(2)} for mode-${routingMode}-tier-${tier}`)
    } else {
      console.log(`[Workflow] Layer 9 P1.1 — no prior workflow history (first runs) → base budget ${BASE_TOKEN_BUDGET}`)
    }
  } catch (histErr) {
    console.warn('[Workflow] Layer 9 P1.1 — historical feedback failed (fail-open, using base budget):', histErr instanceof Error ? histErr.message : String(histErr))
  }

  const metricsCollector: MetricsCollector = createMetricsCollector(
    sessionId,
    sessionId, // planId = sessionId for now (no separate plan table)
    request.routing?.mode ?? 'A', // routingMode (A/B/C from TL assessment)
    request.routing?.tier ?? 1,   // tier (1/2/3 from TL assessment)
    effectiveTokenBudget // Layer 9 P1.1: history-adjusted (was 100000 placeholder)
  )

  try {
    // ===== STEP 0: Resolve TL agent (Agent Resolution Layer — C1 Fix) =====
    // Resolve TL first — needed for routing analysis
    // If TL is missing from DB, lazy seed from hardcoded definition
    if (isAborted()) { console.log('[Workflow] Aborted before agent resolution'); return }

    const tlResolved = await resolveAgent('TL')
    ctx.resolvedAgentsCache.set('TL', tlResolved)

    if (tlResolved.source === 'missing') {
      const errorMsg = 'Không tìm thấy agent TL (MEGATRON). Workflow cần ít nhất agent TL để chạy.'
      console.error(`[Workflow] ${errorMsg}`)
      safeEmit({ type: 'error', agent: 'SYSTEM', message: errorMsg })
      // Phase 2 SMOLAB Proposal 7 — flush Layer 9 metrics even on early abort
      // (fire-and-forget; never crash the workflow here).
      await metricsCollector.flush().catch((mErr) => {
        console.error('[Workflow] Layer 9 flush failed (TL missing path):', mErr)
      })
      await completeSession(sessionId, 'failed')
      // FIX 2026-09-15 #2 (P2): team thiếu TL = vấn đề hạ tầng cấu hình — gửi
      // thẳng Omega để điều phối khắc phục (fail-open).
      await escalateWorkflowFailureToOmega({
        sessionId,
        reason: 'Code Team thiếu agent TL',
        detail: errorMsg,
        spec: userRequest,
        emit: safeEmit,
      })
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
      await runPipeline(preComputedRouting, sessionId, userRequest, safeEmit, startTime, isAborted, ctx, metricsCollector, effectiveTokenBudget)
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
      prompt: await buildTLPrompt(userRequest, messages),
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

      await runPipeline(fallbackDecision, sessionId, userRequest, safeEmit, startTime, isAborted, ctx, metricsCollector, effectiveTokenBudget)
      return
    }

    console.log(`[Workflow] Routing: Mode ${routingDecision.mode}, Tier ${routingDecision.tier}, Score ${routingDecision.score}`)
    console.log(`[Workflow] Reasoning: ${routingDecision.reasoning}`)
    if (routingDecision.targetFiles?.length) {
      console.log(`[Workflow] Target files (${routingDecision.targetFiles.length}): ${routingDecision.targetFiles.join(', ')}`)
    }
    if (routingDecision.filesInspected?.length) {
      console.log(`[Workflow] Files inspected during recon (${routingDecision.filesInspected.length}): ${routingDecision.filesInspected.join(', ')}`)
    }
    if (routingDecision.riskLevel) {
      console.log(`[Workflow] Risk level: ${routingDecision.riskLevel}`)
    }
    if (routingDecision.executionPlan?.length) {
      console.log(`[Workflow] Execution plan: ${routingDecision.executionPlan.length} steps`)
      routingDecision.executionPlan.forEach(s => console.log(`  Step ${s.step}: ${s.description} [${s.agent}, risk=${s.risk}] → ${s.targetFiles.join(', ')}`))
    }

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
    await runPipeline(routingDecision, sessionId, userRequest, safeEmit, startTime, isAborted, ctx, metricsCollector, effectiveTokenBudget)
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
    // FIX 2026-09-15 #2 (P2): fatal error cũng AUTO-ESCALATE về Omega — trước
    // đây lỗi này chỉ log console + SSE, Omega không nhận được tín hiệu gì.
    await escalateWorkflowFailureToOmega({
      sessionId,
      reason: 'Workflow fatal error',
      detail: errorMsg,
      spec: userRequest,
      routing: request.routing,
      emit: safeEmit,
    })
  }
}

// ==================== FIX 2026-09-15 #2 — AUTO-ESCALATE → OMEGA (P2) ====================

/**
 * Audit Team Code 2026-09-15 (phát hiện #2): trước đây mọi terminal failure
 * của Code Team workflow (TL checkpoint ESCALATE, fatal error, TL missing)
 * chỉ tới USER qua SSE + completeSession — Omega orchestrator KHÔNG nhận
 * được tín hiệu gì ("đường (c): ESCALATE chỉ tới USER, Omega không nhận được").
 *
 * Giờ mirror AUTO-ESCALATE của goal-loop (agent-goal-loop.ts [G]): khi workflow
 * kết thúc KHÔNG thành công → consultOmega({autoTriggered:true}) → advisory:
 *   1. emit SSE 'omega_escalation' (route.ts persist ChatMessage + UI render)
 *   2. ghi worklog row position OMEGA — request_code_team SOP report (steps)
 *      + self-direction scan đọc được (bằng chứng escalation tồn tại trong DB)
 *   3. digest issues/unfixedBugs/tool-fail từ worklog THẬT đính kèm (evidence)
 *
 * Fail-open tuyệt đối: lỗi consult KHÔNG được đổi outcome workflow. Mỗi run
 * chỉ gọi tại 1 terminal path (các path loại nhau loại trừ nhau) → max 1 lần.
 */
async function escalateWorkflowFailureToOmega(params: {
  sessionId: string
  reason: string
  detail: string
  spec?: string
  routing?: { mode?: string; tier?: number; score?: number }
  completedAgents?: string[]
  totalDurationMs?: number
  emit: SSEEmitter
}): Promise<void> {
  const { sessionId, reason, detail, emit } = params
  try {
    // Bằng chứng thật cho Omega: issues/unfixedBugs/tool-fail từ worklog đã ghi
    let issuesDigest = ''
    try {
      const worklogs = await readWorklog(sessionId)
      const allIssues = worklogs.flatMap(w => w.issues).filter(i => !i.fixApplied)
      const unfixed = worklogs.flatMap(w => w.unfixedBugs || [])
      const parts: string[] = []
      if (allIssues.length > 0) {
        parts.push(`Issues chưa fix: ${allIssues.slice(-6).map(i => `[${i.severity}] ${i.type}: ${i.description.slice(0, 120)}`).join('; ')}`)
      }
      if (unfixed.length > 0) {
        parts.push(`Bugs chưa fix: ${unfixed.slice(-6).map(b => `[${b.severity}] ${b.description.slice(0, 120)}`).join('; ')}`)
      }
      const failedTools = worklogs
        .flatMap(w => (w.toolCallsLog || []).filter(t => !t.success).map(t => `${t.tool}: ${t.result.slice(0, 100)}`))
      if (failedTools.length > 0) {
        parts.push(`Tool fail gần nhất: ${failedTools.slice(-5).join(' | ')}`)
      }
      issuesDigest = parts.join('\n')
    } catch { /* fail-open — digest rỗng vẫn consult được */ }

    const { consultOmega } = await import('@/lib/omega-orchestrator')
    const consult = await consultOmega({
      problem: `Code Team workflow (session ${sessionId.slice(0, 20)}) kết thúc KHÔNG thành công — ${reason}. Chi tiết: ${detail.slice(0, 600)}`,
      context: [
        params.spec ? `Yêu cầu gốc: ${params.spec.replace(/\s+/g, ' ').slice(0, 500)}` : '',
        params.routing ? `Routing: Mode ${params.routing.mode ?? '?'}/Tier ${params.routing.tier ?? '?'} (score ${params.routing.score ?? '?'})` : '',
        params.completedAgents && params.completedAgents.length > 0 ? `Agents đã chạy: ${params.completedAgents.join(' → ')}` : '',
        params.totalDurationMs ? `Thời lượng: ${Math.round(params.totalDurationMs / 1000)}s` : '',
      ].filter(Boolean).join('\n'),
      attempted: issuesDigest || '(worklog chưa ghi issue/tool fail nào)',
      callingAgent: 'MEGATRON (Code Team TL)',
      severity: 'high',
      autoTriggered: true,
    })

    if (consult.success && consult.text) {
      emit({
        type: 'omega_escalation',
        sessionId,
        agent: 'Omega',
        position: 'OMEGA',
        advisory: consult.text.slice(0, 2000),
        reason: `${reason}: ${detail}`.slice(0, 300),
        tokensUsed: consult.tokensUsed,
      })
      // Worklog row position OMEGA — hiện trong SOP report steps + scan source
      const entry: WorklogEntry = {
        sessionId,
        agentName: 'Omega',
        position: 'OMEGA',
        step: 'omega_escalation',
        timestamp: new Date(),
        summary: `AUTO-ESCALATE → Omega: ${reason} — advisory ${consult.tokensUsed} tokens`,
        completed: [],
        inProgress: [],
        issues: [{ severity: 'high', type: 'workflow_failure', description: `${reason}: ${detail}`.slice(0, 300) }],
        suggestions: [consult.text.slice(0, 400)],
        concerns: [],
        codeLocationMap: { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
        nextSteps: [],
        outputForNext: consult.text.slice(0, 2000),
      }
      await writeWorklog(entry, 0)
      console.log(`[Workflow] AUTO-ESCALATE → Omega: advisory nhận (${consult.tokensUsed} tokens) — đã emit + ghi worklog OMEGA [session ${sessionId.slice(0, 12)}]`)
    } else {
      console.warn(`[Workflow] AUTO-ESCALATE → Omega KHÔNG trả advisory (fail-open): ${consult.error ?? 'không rõ lý do'}`)
    }
  } catch (err) {
    console.warn('[Workflow] AUTO-ESCALATE → Omega thất bại (fail-open):', err instanceof Error ? err.message : String(err))
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
  // Layer 9 P1.1: history-adjusted budget (từ runWorkflow) — dùng cho
  // resource_limit detector của detectAndPersistFailurePattern
  tokenBudget: number,
): Promise<void> {
  const pipeline = getPipeline(routingDecision.mode, routingDecision.tier)
  let spec = routingDecision.spec || userRequest // Spec gốc cho toàn bộ pipeline

  // ━━━ ROUND-37 V4 — LAYER 8 + LAYER 6.3 SỐNG LẠI (scaffolding wire) ━━━
  // progress-reporter (communication) + checkpoint-manager (state-management)
  // trước đây là dead scaffolding — build xong không ai gọi; doc clarify route
  // hứa event `progress_report`/`final_report` mà chưa từng được emit. Giờ:
  //   • progressReporter.formatStepReport → SSE `progress_report` sau mỗi step
  //   • progressReporter.formatFinalReport → SSE `final_report` cuối workflow
  //   • checkpointManager.shouldCreateCheckpoint → saveCheckpoint (durable
  //     CodeTeamCheckpoint rows — bảng đã có sẵn từ migration 20260618154653)
  // Fail-open tuyệt đối — Layer 8/6 KHÔNG được phép làm hỏng workflow.
  const progressReporter = (await import('@/lib/communication/progress-reporter')).createProgressReporter()
  const checkpointManager = (await import('@/lib/state-management/checkpoint-manager')).createCheckpointManager(sessionId)
  const stepStates: Record<string, import('@/lib/state-management/types').StepState> = {}
  const workflowErrors: Array<import('@/lib/error-handling').ErrorRecord> = []
  let workflowTokensUsed = 0
  let workflowTimeSpent = 0

  // Get TL agent name from resolved cache (BUG 12 fix: don't hardcode 'MEGATRON')
  const tlAgent = ctx.resolvedAgentsCache.get('TL')
  const completedAgents: string[] = tlAgent ? [tlAgent.name] : ['MEGATRON'] // TL already completed in Step 1

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

    // USER REQUEST 2026-08-31: user bấm nút Dừng (POST /api/agent-run) → dừng
    // cả workflow giữa các step, không chỉ step đang chạy.
    if (isSessionCancelled(sessionId)) {
      console.log(`[Workflow] 🛑 Session ${sessionId} bị user HỦY — dừng pipeline tại step ${i} (${step.position}/${step.step})`)
      emit({ type: 'error', agent: 'SYSTEM', message: '⏹ Đã dừng workflow theo yêu cầu của bạn.' })
      await metricsCollector.flush().catch((mErr) => {
        console.error('[Workflow] Layer 9 flush failed (cancel path):', mErr)
      })
      // FIX 2026-09-15 #1 (P1): user hủy ≠ workflow lỗi — persist 'cancelled'
      // (trước đây 'failed' làm nhiễm tín hiệu thất bại cho scan/SOP report).
      // KHÔNG auto-escalate Omega: đây là ý muốn người dùng, không phải sự cố.
      await completeSession(sessionId, 'cancelled', Date.now() - workflowStartTime, completedAgents)
      return
    }

    // Check if workflow was aborted (client disconnected)
    if (isAborted()) {
      console.log(`[Workflow] Aborted at step ${i} (${step.position}/${step.step}) — client disconnected`)
      // Phase 2 SMOLAB Proposal 7 — flush Layer 9 metrics before early-exit.
      await metricsCollector.flush().catch((mErr) => {
        console.error('[Workflow] Layer 9 flush failed (abort path):', mErr)
      })
      // FIX 2026-09-15 #1 (P1): client ngắt kết nối ≠ lỗi hệ thống — persist
      // 'cancelled' thay vì 'failed' (tín hiệu trung thực cho scan/SOP).
      await completeSession(sessionId, 'cancelled', Date.now() - workflowStartTime, completedAgents)
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
      // G2-B max 5 vòng iteration (was 3 — too few for complex bug-fix loops)
      // TL self-verify (Mode A) max 5 vòng iterate
      // TL analyze (routing) max 15 — enough for recon + JSON production (was 6 — too few)
      // Others max 25 — large tasks need many ReAct iterations (Claude Code uses 50+)
      //   Previously 10 — agents would stop mid-task after a few tool calls.
      maxIterations: (step.position === 'G2-B' || (step.position === 'TL' && step.step === 'verify')) ? 5
        : (step.position === 'TL' && step.step === 'analyze') ? 15
        : 25,
    })

    // Parse worklog from agent output
    // Edge case: If content starts with "Error:" → agent step failed
    // Write a minimal worklog marking the step as failed so subsequent agents have context
    const isFailedStep = agentResult.content.startsWith('Error:')
    const parsedWorklog = parseWorklogFromOutput(agentResult.content)

    // Phase 2 SMOLAB Proposal 7 — Record step completion/error for Layer 9.
    // If isFailedStep, also push an ErrorRecord into the step's error log so
    // errorsByType aggregation in getCurrentMetrics() captures the failure.
    // Layer 9 P0.2 (2026-08-25): tokensUsed is now REAL — accumulated across
    // the step's ReAct iterations inside runAgentStep. timeSpent from
    // agentResult.duration (ms).
    if (isFailedStep) {
      metricsCollector.recordStepError(stepId, {
        id: `err-${sessionId}-${stepId}-${Date.now()}`,
        timestamp: new Date(),
        // Layer 9 P1.2 (2026-08-25): error taxonomy thay vì hardcode 'runtime'.
        // Trước P1.2, MỌI lỗi đều dán 'runtime' → 2 lỗi nguyên nhân khác hẳn
        // vẫn bị detectFailurePattern tính là "repeated_error" → khuyến nghị
        // đổi approach sai. Phân loại transient (mạng/429/503/timeout — tự hồi)
        // vs systematic (tool fail/logic — cần đổi approach).
        errorType: classifyWorkflowError(agentResult.content),
        severity: 'high',
        message: agentResult.content.slice(0, 500),
        rootCause: 'Agent step returned Error: prefix',
        fixStrategy: 'surgical',
        fixApplied: false,
        loopDetected: false,
        loopCount: 0,
      })

      // ━━━ Layer 9 P1.3 (2026-08-25) — kẹp đoạn [4]: persist failure patterns ━━━
      // Trước P1.3, detectFailurePattern/persistFailurePattern chỉ tồn tại trong
      // master-orchestrator phantom path — FailurePattern table 0 rows mãi mãi.
      // Giờ mỗi step fail trong PRODUCTION path được:
      //   1. Phát hiện pattern (detectFailurePattern — reused nguyên vẹn)
      //   2. Persist (persistFailurePattern) — nguồn dữ liệu sống cho Layer 9
      //   3. Nếu pattern đủ nghiêm trọng (repeated ≥ 2) → persistAdaptationLog
      //      ghi nhận quyết định cần thiết-ứng (chưa auto-apply — P1.3 chỉ lưu,
      //      auto-apply chờ đủ dữ liệu để tin)
      // Fire-and-forget: không bao giờ block workflow vì learning side-channel.
      // FIX (metrics thật): truyền token đã dùng của step + budget hiện tại
      // xuống detector — trước đây metrics toàn 0 giữ tokenEfficiency=0 →
      // resource_limit detector chết.
      void detectAndPersistFailurePattern(
        sessionId,
        stepId,
        agentResult.content,
        {
          totalTokensUsed: typeof agentResult.tokensUsed === 'number' ? agentResult.tokensUsed : 0,
          totalTokensBudgeted: tokenBudget,
          totalTimeSpent: agentResult.duration,
        }
      ).catch((pErr) => {
        console.warn('[Workflow] Layer 9 P1.3 pattern persistence failed (non-fatal):', pErr instanceof Error ? pErr.message : String(pErr))
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
      // Layer 9 P0.2: REAL token usage (accumulated across the step's ReAct
      // iterations) — replaces the literal-0 placeholder that kept
      // tokenEfficiency at 0 and severed the resource_limit detector.
      typeof agentResult.tokensUsed === 'number' ? agentResult.tokensUsed : 0,
      agentResult.duration, // timeSpent (ms)
    )

    // ━━━ ROUND-37 V2a — ĐÓNG VÒNG ADAPTATION ━━━
    // Session có adaptation đang chờ → kết quả step NÀY là bằng chứng:
    // pass → markSessionAdaptationOutcome(true) (resolve FailurePattern,
    // xoá directives); fail tiếp → outcome(false) (giữ directives cho step sau).
    // Fire-and-forget fail-open.
    void (async () => {
      try {
        const { markSessionAdaptationOutcome } = await import('@/lib/learning/adaptation-engine')
        await markSessionAdaptationOutcome(sessionId, !isFailedStep, stepId)
      } catch { /* fail-open */ }
    })()

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

    // ━━━ ROUND-37 V4 — Layer 8 progress_report + Layer 6.3 checkpoint ━━━
    // StepState từ kết quả THẬT của step → progress-reporter format → SSE
    // `progress_report` (event doc clarification route đã hứa từ trước).
    // Checkpoint: step.isCheckpoint / G2-A code → saveCheckpoint durable.
    try {
      const stepState: import('@/lib/state-management/types').StepState = {
        id: stepId,
        type: step.step as import('@/lib/code-team/types').StepType,
        status: isFailedStep ? 'failed' : 'completed',
        agentPosition: step.position,
        description: step.description,
        result: {
          success: !isFailedStep,
          filesCreated: [],
          filesModified: (parsedWorklog?.codeLocationMap?.filesToRead ?? []).map(f => f.path).slice(0, 10),
          summary: (parsedWorklog?.summary || agentResult.content.slice(0, 200)),
          outputForNext: '',
        },
        tokensUsed: typeof agentResult.tokensUsed === 'number' ? agentResult.tokensUsed : 0,
        tokensBudgeted: tokenBudget,
        timeSpent: agentResult.duration,
        errors: isFailedStep
          ? [{ id: `err-${stepId}`, timestamp: new Date(), errorType: 'runtime', severity: 'high', message: agentResult.content.slice(0, 200), rootCause: 'Agent step failed', fixStrategy: 'surgical', fixApplied: false, loopDetected: false, loopCount: 0 }]
          : [],
        startedAt: new Date(Date.now() - agentResult.duration).toISOString(),
        completedAt: new Date().toISOString(),
      }
      stepStates[stepId] = stepState
      workflowTokensUsed += stepState.tokensUsed ?? 0
      workflowTimeSpent += stepState.timeSpent ?? 0
      if (stepState.errors) workflowErrors.push(...stepState.errors)

      const stepIndex = Object.keys(stepStates).length
      emit({
        type: 'progress_report',
        formattedReport: progressReporter.formatStepReport(stepState, stepIndex, pipeline.length),
        stepIndex,
        totalSteps: pipeline.length,
        status: stepState.status,
      })

      // Checkpoint durable (Layer 6.3) — fire-and-forget fail-open
      const progressNow = {
        planId: sessionId,
        totalSteps: pipeline.length,
        completedSteps: Object.values(stepStates).filter(s => s.status === 'completed').length,
        failedSteps: Object.values(stepStates).filter(s => s.status === 'failed').length,
        currentStep: pipeline.findIndex(p => p.position === step.position && p.step === step.step),
        steps: { ...stepStates },
        totalTokensUsed: workflowTokensUsed,
        totalTokensBudgeted: tokenBudget,
        totalTimeSpent: workflowTimeSpent,
        errors: [...workflowErrors],
        startedAt: new Date(workflowStartTime).toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      }
      if (checkpointManager.shouldCreateCheckpoint(step as unknown as import('@/lib/code-team/types').PipelineStep, progressNow)) {
        const stepIdx = pipeline.findIndex(p => p.position === step.position && p.step === step.step)
        void checkpointManager.saveCheckpoint({
          progress: progressNow,
          context: [],
          routing: routingDecision,
          spec,
          pipeline: pipeline.map(p => ({ ...p, step: p.step as import('@/lib/code-team/types').StepType })) as import('@/lib/code-team/types').PipelineStep[],
          currentStepIndex: stepIdx < 0 ? 0 : stepIdx,
        }).then(() => {
          console.log(`[Workflow] V4 — checkpoint durable saved sau ${stepId} (Layer 6.3 sống)`)
        }).catch(() => { /* fail-open */ })
      }
    } catch (l8Err) {
      console.warn('[Workflow] V4 progress-report/checkpoint failed (non-blocking):', l8Err instanceof Error ? l8Err.message : String(l8Err))
    }

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

        // FIX 2026-09-15 #1 (P1 — audit Team Code): ESCALATE giờ là terminal
        // state THẬT — persist 'escalated' (trước đây ghi 'failed' làm mất tín
        // hiệu ở SOP report flag + self-direction scan) và truyền kèm
        // completedAgents (trước đây path này bỏ qua → session neo agent cũ).
        const totalDuration = Date.now() - workflowStartTime
        // Phase 2 SMOLAB Proposal 7 — flush Layer 9 metrics before early-exit
        // (escalate path). Fire-and-forget; never block the workflow.
        await metricsCollector.flush().catch((mErr) => {
          console.error('[Workflow] Layer 9 flush failed (escalate path):', mErr)
        })
        await completeSession(sessionId, 'escalated', totalDuration, completedAgents)
        // FIX 2026-09-15 #2 (P2): ESCALATE tự động gửi vấn đề tới OMEGA —
        // mirror AUTO-ESCALATE của goal-loop (trước đây Omega không nhận gì).
        await escalateWorkflowFailureToOmega({
          sessionId,
          reason: `TL checkpoint ESCALATE sau ${step.position}`,
          detail: verifyResult.reasoning,
          spec,
          routing: routingDecision,
          completedAgents,
          totalDurationMs: totalDuration,
          emit,
        })
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

  // ===== CI-3 B4 (Task 13-c) — TASK SUMMARY cuối team workflow (liên tác vụ) =====
  // Lưu task_summary (kind='task_summary') vào Kho Context để workflow/chat
  // run sau trong cùng session nạp lại bức tranh dài hạn (goal-loop
  // buildPriorTaskSummariesBlock). Summary deterministic từ dữ liệu có sẵn
  // (spec + status + agents + quality) — 0 LLM call thêm, cap 500 chars.
  // Fail-open: lỗi archive KHÔNG được đổi outcome workflow (đã completed).
  // Chỉ đường SUCCESS (WORKFLOW DONE) — escalate/cancel/abort path là
  // follow-up cho parent (tránh đụng vùng 13-d đang sửa).
  try {
    const { archiveContext } = await import('@/lib/context-store')
    const tlName = ctx.resolvedAgentsCache.get('TL')?.name || 'CodeTeam'
    const wfSummary = `[Team workflow ${finalStatus}] Yêu cầu: ${spec.replace(/\s+/g, ' ').slice(0, 160)} — pipeline ${routingDecision.mode}/${routingDecision.tier} qua ${completedAgents.join(' → ')} trong ${Math.round(totalDuration / 1000)}s${quality.mode !== 'off' ? `, quality gate ${quality.mode} (lint ${quality.lintErrors}, tsc ${quality.tscErrors})` : ''}.`.slice(0, 500)
    const res = await archiveContext({
      runId: sessionId,
      sessionId,
      agentName: tlName,
      kind: 'task_summary',
      content: wfSummary,
      tags: 'final-summary',
    })
    if (res.archived) {
      console.log(`[Workflow] task_summary đã lưu vào Kho Context (${wfSummary.length} chars) — run sau trong session ${sessionId.slice(0, 12)} sẽ nạp`)
    }
  } catch (wfSumErr) {
    console.warn('[Workflow] Lưu task_summary thất bại (fail-open):', wfSumErr instanceof Error ? wfSumErr.message : String(wfSumErr))
  }

  // Task 17-b (Layer 9) — observation: workflow kết thúc thành công dù đã
  // inject "bài học từ thất bại trước" → bài học có thể đã phát huy tác dụng
  // (chỉ log, không logic phức tạp hơn — auto-apply mạnh hơn chờ đủ dữ liệu).
  if ((ctx.layer9HintsInjected ?? 0) > 0) {
    console.log(`[Workflow] Layer 9 observation — workflow ${finalStatus} với ${ctx.layer9HintsInjected} hint(s) đã inject (bài học từ thất bại trước được áp dụng) [session ${sessionId.slice(0, 12)}]`)
  }

  // Phase 2 SMOLAB Proposal 7 — flush Layer 9 metrics before workflow_done emit.
  // This is the SUCCESS path: every step recordStart/recordComplete has been
  // called inside the for-loop above. flush() persists ExecutionMetrics row
  // to SQLite (Prisma model added in Phase 6 Prop 2). Fire-and-forget pattern:
  // failure here does NOT change the workflow outcome (already completed).
  await metricsCollector.flush().catch((mErr) => {
    console.error('[Workflow] Layer 9 flush failed (success path):', mErr)
  })

  // ━━━ ROUND-37 V4 — Layer 8 final_report (sự kiện doc đã hứa, giờ emit thật) ━━━
  try {
    const completedCount = Object.values(stepStates).filter(s => s.status === 'completed').length
    const failedCount = Object.values(stepStates).filter(s => s.status === 'failed').length
    emit({
      type: 'final_report',
      formattedReport: progressReporter.formatFinalReport({
        planId: sessionId,
        completedSteps: completedCount,
        failedSteps: failedCount,
        totalSteps: pipeline.length,
        steps: stepStates,
        errors: workflowErrors,
        totalTokensUsed: workflowTokensUsed,
        totalTokensBudgeted: tokenBudget,
        totalTimeSpent: workflowTimeSpent || (Date.now() - workflowStartTime),
        startedAt: new Date(workflowStartTime).toISOString(),
        lastUpdatedAt: new Date().toISOString(),
      }),
      totalSteps: pipeline.length,
      completedSteps: completedCount,
      failedSteps: failedCount,
      totalTokensUsed: workflowTokensUsed,
      totalTimeSpent: workflowTimeSpent,
    })
  } catch (l8FinalErr) {
    console.warn('[Workflow] V4 final_report failed (non-blocking):', l8FinalErr instanceof Error ? l8FinalErr.message : String(l8FinalErr))
  }

  emit({
    type: 'workflow_done',
    totalDuration,
    sessionId,
    status: finalStatus,
    quality: quality.mode === 'off' ? undefined : quality,
  })
  console.log(`[Workflow] Completed in ${totalDuration}ms. Agents: ${completedAgents.join(' → ')} (quality: ${quality.mode})`)
}

// ==================== CI-3 B5 — OVERFLOW HANDLING (digest-first + auto-resume) ====================

/**
 * Quyết định của handleOverflow khi ReAct conversation vượt ngưỡng token:
 *  - 'continue'         → digest đã kéo context xuống dưới ngưỡng — KHÔNG pause,
 *                         ReAct loop chạy tiếp với lịch sử đã nén.
 *  - 'pause-auto-resume'→ digest không cứu được nhưng chưa vượt cap N — pause
 *                         (hành vi cũ) rồi TỰ ĐỘNG resume in-process sau 1 khoảng ngắn.
 *  - 'pause-manual'     → digest không cứu được VÀ đã vượt cap N (hoặc lỗi
 *                         fail-open) → pause THẬT chờ POST resume thủ công.
 */
export type OverflowAction = 'continue' | 'pause-auto-resume' | 'pause-manual'

export interface HandleOverflowParams {
  /** Mảng messages của ReAct loop — digest MUTATE in-place (splice) như rolling digest. */
  messages: CompressionMessage[]
  /** Ước lượng token TRƯỚC digest (caller đã tính bằng estimateTokens). */
  currentTokens: number
  /** Ngưỡng overflow (CONTEXT_OVERFLOW_THRESHOLD — 80k mặc định). */
  threshold: number
  /** Session id — đọc contextOverflowCount hiện tại khi param đó bị omit. */
  sessionId: string
  agentName: string
  position: string
  /** Index instruction được bảo vệ cuối cùng (biên nén — như rolling digest). */
  protectedStartIndex: number
  /** Số lần overflow TRƯỚC lần này; omit → tự đọc từ DB (fail-open → 0). */
  contextOverflowCount?: number
  /** Cap auto-resume mỗi session — mặc định MAX_AUTO_RESUME_PER_SESSION (3). */
  maxAutoResumes?: number
  /** Số message gần nhất giữ nguyên khi digest — mặc định KEEP_RECENT_MESSAGES. */
  keepRecent?: number
  /** Kế toán token digest vào budget của step. */
  onTokens?: (tokens: number) => void
  /** Tag archive Kho Context (CI-3 B2) cho digest khi nén thành công. */
  archive?: { runId?: string | null; sessionId?: string | null; agentName?: string | null }
}

export interface HandleOverflowResult {
  action: OverflowAction
  /** estimateTokens(messages) SAU digest attempt (bằng currentTokens khi digest null). */
  tokensAfter: number
  /** Chars tiết kiệm được (0 khi digest trả null). */
  savedChars: number
  digestMethod: string | null
  /** Số hiệu auto-resume (1..N) khi action='pause-auto-resume'; null trong các case khác. */
  autoResumeNumber: number | null
}

/**
 * CI-3 B5 (Task 13-d) — Xử lý context overflow trong ReAct loop, digest-first:
 *
 *  1. TRƯỚC TIÊN chạy compressConversation — nếu nén thành công (≠ null) và
 *     sau nén estimateTokens(messages) < threshold → 'continue' (không pause;
 *     vòng lặp sau tự nhẹ hơn).
 *  2. Nếu nén KHÔNG giúp được (segment đã tối thiểu / savings không đủ / vẫn
 *     ≥ threshold sau nén) → pause. Chưa vượt cap N (mặc định 3, đếm qua
 *     contextOverflowCount) → 'pause-auto-resume'; vượt → 'pause-manual'.
 *
 * FAIL-OPEN TUYỆT ĐỐI: mọi lỗi digest/đọc-đếm đều nuốt bên trong và rơi về
 * nhánh pause — KHÔNG BAO GIỜ throw (caller vẫn bọc thêm try/catch để về
 * hành vi pause cũ nguyên vẹn nếu có lỗi bất ngờ).
 */
export async function handleOverflow(params: HandleOverflowParams): Promise<HandleOverflowResult> {
  const { messages, currentTokens, threshold, sessionId, agentName, position, protectedStartIndex, onTokens, archive } = params
  const maxAutoResumes = params.maxAutoResumes ?? MAX_AUTO_RESUME_PER_SESSION
  const keepRecent = params.keepRecent ?? KEEP_RECENT_MESSAGES

  // ---- BƯỚC 1: digest-first — thử tự cứu bằng nén trước khi pause ----
  let comp: CompressionResult | null = null
  try {
    comp = await compressConversation({
      messages,
      protectedStartIndex,
      keepRecent,
      // workflow không giữ evidence log riêng → heuristic fallback suy xuất từ
      // transcript (tool JSON có sẵn tool/success) — giống rolling digest B1.
      minCompressibleMessages: 6, // < 3 cặp (assistant + tool reply) → không nén
      llmContext: 'workflow-overflow-compression',
      onTokens,
      archive,
    })
  } catch (digestErr) {
    // compressConversation đã fail-open nội bộ — belt-and-suspenders cho caller lỗi bất ngờ.
    console.warn(`[Workflow] ${agentName} (${position}) overflow digest FAILED — rơi về nhánh pause: ${digestErr instanceof Error ? digestErr.message : String(digestErr)}`)
  }
  const tokensAfter = estimateTokens(messages)
  if (comp && tokensAfter < threshold) {
    console.log(`[Workflow] ${agentName} (${position}) overflow ~${currentTokens} tokens → rolling digest giảm về ~${tokensAfter} — tiếp tục không pause`)
    return { action: 'continue', tokensAfter, savedChars: comp.savedChars, digestMethod: comp.method, autoResumeNumber: null }
  }

  // ---- BƯỚC 2: digest không cứu được → pause; quyết định auto-resume qua cap N ----
  let priorCount = params.contextOverflowCount
  if (priorCount === undefined) {
    try {
      const meta = await getSessionMetadata(sessionId)
      priorCount = meta?.contextOverflowCount ?? 0
    } catch {
      priorCount = 0 // fail-open: đọc DB lỗi → coi như chưa từng overflow
    }
  }
  const thisOverflowNumber = priorCount + 1
  const autoResumeNumber = thisOverflowNumber <= maxAutoResumes ? thisOverflowNumber : null
  return {
    action: autoResumeNumber !== null ? 'pause-auto-resume' : 'pause-manual',
    tokensAfter,
    savedChars: comp?.savedChars ?? 0,
    digestMethod: comp?.method ?? null,
    autoResumeNumber,
  }
}

/**
 * CI-3 B5 — Lên lịch auto-resume session sau overflow pause (NON-BLOCKING):
 * đợi AUTO_RESUME_DELAY_MS rồi gọi performSessionResume — ĐÚNG code path của
 * POST /api/workflow/resume (atomic check-and-acquire + stale-lock 30-min
 * recovery + buildResumeContext). Fire-and-forget: KHÔNG block step, lỗi bất
 * kỳ chỉ log — session giữ nguyên pause chờ can thiệp thủ công (fail-open).
 */
function scheduleAutoResume(sessionId: string, resumeNumber: number, agentName: string, position: string): void {
  console.log(`[Workflow] auto-resume #${resumeNumber} cho session ${sessionId} sau digest overflow — lên lịch kích hoạt sau ${AUTO_RESUME_DELAY_MS}ms (agent ${agentName}/${position})`)
  setTimeout(() => {
    void (async () => {
      const result = await performSessionResume(sessionId)
      if (result.ready) {
        console.log(`[Workflow] auto-resume #${resumeNumber} cho session ${sessionId} sau digest overflow — session ACTIVE lại (overflow #${result.session?.contextOverflowCount}); agent kế tiếp lấy resume context qua cùng code path POST /api/workflow/resume`)
      } else if (result.conflict) {
        console.warn(`[Workflow] auto-resume #${resumeNumber} cho session ${sessionId}: lock đang bị agent khác giữ (409) — bỏ qua, giữ pause chờ thủ công`)
      } else if (result.flagDisabled) {
        console.warn(`[Workflow] auto-resume #${resumeNumber} cho session ${sessionId}: ENABLE_SESSION_RESUME đã tắt giữa chừng — bỏ qua`)
      } else {
        console.warn(`[Workflow] auto-resume #${resumeNumber} cho session ${sessionId} KHÔNG thành công (không tìm thấy / DB lỗi) — giữ pause chờ POST /api/workflow/resume?sessionId=${sessionId} thủ công`)
      }
    })().catch((err) => {
      // Fail-open tuyệt đối — KHÔNG BAO GIỜ crash step vì auto-resume lỗi.
      console.error(`[Workflow] auto-resume #${resumeNumber} cho session ${sessionId} FAILED (session giữ pause chờ thủ công):`, err instanceof Error ? err.message : String(err))
    })
  }, AUTO_RESUME_DELAY_MS)
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
}): Promise<{ content: string; duration: number; tokensUsed: number }> {
  const { position, step, prompt, sessionId, emit, ctx } = params
  const stepStartTime = Date.now()

  // ROUND-37 V2a — Layer 9 adaptation APPLY THẬT: session từng bị phát hiện
  // failure-pattern (count≥2) → chiến lược thích ứng (applyAdaptation) điều
  // khiển step NÀY: reduce_scope giảm vòng ReAct, compress_context hạ ngưỡng
  // nén sớm, các chiến lược khác inject directive (block dưới). Fail-open tuyệt đối.
  let adaptedMaxIterations = params.maxIterations ?? 25
  let stepOverflowThreshold = CONTEXT_OVERFLOW_THRESHOLD
  let sessionEscalated = false
  try {
    const adaptation = await import('@/lib/learning/adaptation-engine')
    adaptedMaxIterations = adaptation.getAdaptedMaxIterations(sessionId, params.maxIterations ?? 25)
    if (adaptation.shouldCompressContextEarly(sessionId)) {
      // compress_context → ngưỡng overflow của step này hạ 30% (nén sớm)
      stepOverflowThreshold = Math.floor(CONTEXT_OVERFLOW_THRESHOLD * 0.7)
    }
    sessionEscalated = adaptation.hasEscalation(sessionId)
  } catch { /* fail-open — giữ mặc định */ }
  const maxIterations = adaptedMaxIterations

  // Resolve agent from per-workflow cache (populated by runPipeline) or on-demand
  const agent = ctx.resolvedAgentsCache.get(position) || await resolveAgent(position)
  const defaultTools = agent.tools.length > 0 ? agent.tools : getAgentTools(position)
  // ━━━ 21-c — PROMPT-SIDE TOOL-ACCESS ENFORCEMENT ━━━
  // ToolAssignment override (Tools Manager UI / Omega manage_tools): tool bị
  // disable → loại khỏi whitelist của step này (LLM không thấy tool trong
  // schemas); tool được enable-thêm → xuất hiện. Fail-open: lỗi DB → giữ mặc định.
  let tools = defaultTools
  try {
    const { getEffectiveToolNames } = await import('@/lib/tool-access')
    tools = await getEffectiveToolNames(agent.name || position, defaultTools)
  } catch { /* fail-open — giữ whitelist mặc định */ }
  // CI-3 B7 (Task 13-e) — system prompt per-step ghép từ CÁC BLOCK CÓ TÊN, cuối
  // cùng áp budget ký tự tổng (budgetPrompt — xem prompt-budget.ts): vượt
  // SYSTEM_PROMPT_BUDGET_CHARS (mặc định 24k) → cắt block priority thấp nhất
  // trước (giữ đầu block), block nhỏ <500 chars không cắt, tổng < budget →
  // prompt GIỮ NGUYÊN 100%. Separator nhúng sẵn trong content mỗi block —
  // join('') tái tạo đúng chuỗi ghép += cũ khi không có cut.
  const systemBlocks: PromptBlock[] = [
    // persona: instruction user-edit từ DB (KHÔNG cap) hoặc prompt mặc định theo position — priority cao nhất
    { name: 'persona', content: agent.instruction || getAgentPrompt(position), priority: 100 },
  ]

  // Inject enabled skills from DB (cached per-workflow in ctx.skillsContext)
  // 2026-09-01 — SKILL ACCESS: lọc skill bị chặn (SkillAssignment enabled=false)
  // cho RIÊNG agent của step này rồi render — agent khác trong cùng workflow vẫn
  // thấy bộ đầy đủ. Fail-open: lỗi → dùng skillsContext chung.
  {
    let skillsText: string | null = null
    if (ctx.skillsRaw && ctx.skillsRaw.length > 0) {
      skillsText = await loadEnabledSkillsForAgent(agent.name || position, ctx.skillsRaw)
    } else if (ctx.skillsContext) {
      skillsText = ctx.skillsContext
    }
    if (skillsText) {
      systemBlocks.push({ name: 'skills', content: skillsText, priority: 20 }) // đã cap 16k nội bộ (renderSkillsText)
    }
  }

  // 2026-08-29 — WORKSPACE CONTEXT cho Team Code (parity với /api/openclaw/chat):
  // root path + cấu trúc cấp 1 + hướng dẫn tool_call format. Trước đây chỉ
  // agents độc lập (chat route) được inject — team Code bị bỏ sót.
  try {
    const wsCtx = await buildWorkspaceContext()
    if (wsCtx.text) {
      systemBlocks.push({ name: 'workspace', content: `\n\n${wsCtx.text}`, priority: 40 })
    }
  } catch (err) {
    console.warn('[Workflow] workspace context inject failed (non-blocking):', err instanceof Error ? err.message : String(err))
  }

  // 2026-08-29 — RUNTIME CAPABILITY REPORT cho Team Code (parity với chat route):
  // probe thật fs/shell/kb/web/skills/mcp/todo → inject danh sách tool verified
  // working vào system prompt để agent biết CHÍNH XÁC cái gì dùng được.
  try {
    const { buildCapabilityPromptBlock } = await import('@/lib/agent-capabilities')
    systemBlocks.push({ name: 'capabilities', content: `\n${await buildCapabilityPromptBlock()}`, priority: 50 })
  } catch (err) {
    console.warn('[Workflow] capability probe failed (non-blocking):', err instanceof Error ? err.message : String(err))
  }

  // AGENT ROSTER (user request 2026-09-08: "các Agents cần nắm được kỹ năng
  // chuyên môn của nhau, xác định khi cần có thể gọi Agents có kỹ năng tốt
  // hơn") — parity với chat route: member Code Team cũng thấy danh bạ đồng
  // nghiệp + cơ chế escalate_problem → Omega orchestrator tư vấn khi gặp vấn đề.
  try {
    const { buildAgentRosterPromptBlock } = await import('@/lib/agent-roster')
    const rosterBlock = await buildAgentRosterPromptBlock(agent.name)
    if (rosterBlock) systemBlocks.push({ name: 'roster', content: `\n${rosterBlock}`, priority: 30 }) // đã cap 8k nội bộ (agent-roster.ts)
  } catch (err) {
    console.warn('[Workflow] agent roster inject failed (non-blocking):', err instanceof Error ? err.message : String(err))
  }

  // ━━━ ROUND-37 V3.1 — EPISODIC BRAIN PRE-ACT (code-team nối vào bộ não) ━━━
  // Trước đây chỉ goal-loop có PRE-ACT; step Code Team chạy không ký ức —
  // task từng fail theo pattern tương tự không được cảnh báo. Giờ: build
  // block bài học + lỗi tương tự cho CHÍNH step prompt này (4s timeout,
  // fail-open), appliedLessonIds track để validate sau step.
  let stepAppliedLessonIds: string[] = []
  try {
    const { buildAgentBrainBlock } = await import('@/lib/episodic-memory/agent-brain')
    const brain = await buildAgentBrainBlock({
      family: 'code-team',
      agentName: `${agent.name} (${position})`,
      task: `${step}: ${prompt}`.slice(0, 1500),
    })
    if (brain.promptBlock) {
      systemBlocks.push({ name: 'episodicBrain', content: brain.promptBlock, priority: 34 })
      stepAppliedLessonIds = brain.appliedLessonIds
      ctx.episodicBrainInjected = (ctx.episodicBrainInjected ?? 0) + brain.appliedLessonIds.length
      console.log(`[Workflow] V3.1 — episodic brain PRE-ACT inject vào ${agent.name} (${position}/${step}): ${brain.appliedLessonIds.length} lesson applied`)
    }
  } catch (err) {
    console.warn('[Workflow] V3.1 episodic brain inject failed (non-blocking):', err instanceof Error ? err.message : String(err))
  }

  // ━━━ Task 17-b — Layer 9 auto-apply CONSERVATIVE: bài học từ thất bại trước ━━━
  // Trước 17-b, Layer 9 là observe-only (persist pattern xong không ai đọc lại)
  // → learning loop hở. Giờ inject hints từ FailurePattern vào system prompt:
  // KHÔNG đổi model/tools/config agent — chỉ nhắc nhở bằng văn bản. Fail-open
  // + cache in-memory 60s + timeout guard bên trong getFailureHintsForAgent.
  try {
    const { getFailureHintsForAgent } = await import('@/lib/learning/strategy-adapter')
    const hints = await getFailureHintsForAgent(agent.name)
    if (hints.length > 0) {
      systemBlocks.push({ name: 'layer9Hints', content: `\n\n--- BÀI HỌC TỪ THẤT BẠI TRƯỚC (Layer 9) ---\n${hints.join('\n')}`, priority: 35 })
      ctx.layer9HintsInjected = (ctx.layer9HintsInjected ?? 0) + hints.length
      console.log(`[Workflow] Layer 9 — injected ${hints.length} failure hint(s) into ${agent.name} (${position}) system prompt`)
    }
  } catch (err) {
    console.warn('[Workflow] Layer 9 hints inject failed (non-blocking):', err instanceof Error ? err.message : String(err))
  }

  // ━━━ ROUND-37 V2a — Layer 9 adaptation directive (APPLY THẬT) ━━━
  // Session có adaptation đang chờ (từ detectAndPersistFailurePattern →
  // applyAdaptationToSession) → inject chỉ thị thích ứng vào system prompt
  // step NÀY. Đây là phần "áp dụng" mà trước đây chỉ dừng ở persistAdaptationLog.
  try {
    const { getAdaptationDirectiveBlock } = await import('@/lib/learning/adaptation-engine')
    const directiveBlock = getAdaptationDirectiveBlock(sessionId)
    if (directiveBlock) {
      systemBlocks.push({ name: 'adaptationDirective', content: directiveBlock, priority: 65 })
      console.log(`[Workflow] Layer 9 V2a — adaptation directive injected vào ${agent.name} (${position})`)
    }
  } catch (err) {
    console.warn('[Workflow] Layer 9 V2a directive inject failed (non-blocking):', err instanceof Error ? err.message : String(err))
  }

  // escalate_to_user đã từng fire trong session → cảnh báo user NGAY đầu step
  if (sessionEscalated) {
    emit({
      type: 'omega_escalation',
      agent: agent.name,
      message: 'Layer 9 phát hiện lỗi lặp ≥3 cách trong session — agent được chỉ thị tập trung hoàn thiện phần chắc chắn + tổng hợp câu hỏi cho bạn thay vì thử cách mới.',
    })
  }

  // 2026-08-29 — AUTO-TODO TRACKING (long-running task progress): mỗi agent step
  // tự upsert 1 todo (idempotencyKey = sessionId:position:step) vào DB → UI panel
  // "Agent Tasks" trong tab Code hiển thị tiến độ workflow theo thời gian thực.
  // Fail-open: todo lỗi KHÔNG bao giờ làm hỏng workflow.
  // CI-2 (Task 11-a): step-todo được gắn runId = sessionId của workflow — nhóm
  // todo của CÙNG workflow session thành 1 khối (không phải runId per-step của
  // tracker vì step-todo được tạo TRƯỚC startAgentRun của step). Run chat mới
  // của session sẽ archive chúng qua archiveStaleRunTodos → per-task isolation.
  const stepTodoKey = `${sessionId}:${position}:${step}`
  const stepTodoContent = `[${position}] ${step} — ${agent.name}`
  const upsertStepTodo = async (status: 'in_progress' | 'completed' | 'failed') => {
    try {
      const existing = await db.todo.findFirst({ where: { sessionId, idempotencyKey: stepTodoKey } })
      if (existing) {
        await db.todo.update({
          where: { id: existing.id },
          data: {
            status,
            // CI-2 — backfill runId cho step-todo cũ (trước CI-2, runId null)
            ...(existing.runId ? {} : { runId: sessionId }),
          },
        })
      } else {
        await db.todo.create({
          data: {
            sessionId,
            agentRole: position,
            content: stepTodoContent,
            status,
            priority: 'medium',
            idempotencyKey: stepTodoKey,
            runId: sessionId,
          },
        })
      }
      // Thought Process panel (2026-08-31): step-todo cũng hiện trong Todos
      // snapshot của run — panel trong chat hiển thị tiến độ từng agent step.
      recordAgentRunTodos(sessionId, [{ id: stepTodoKey, content: stepTodoContent, status, priority: 'medium' }])
    } catch { /* non-blocking */ }
  }
  await upsertStepTodo('in_progress')

  // ===== Thought Process tracking (user request 2026-08-31) =====
  // 1 run = 1 agent step của team workflow. executeTool() tự ghi tool events
  // (kèm kết quả thật) vào run active — hiển thị trong khối Thought Process
  // của chat UI, giống chế độ single-agent.
  const runId = startAgentRun({
    sessionId,
    agentName: agent.name,
    agentPosition: position,
    step,
    task: prompt,
    mode: 'team',
  })
  // USER REQUEST 2026-08-31 (bấm nút Gửi để Dừng): endRun IDEMPOTENT — status
  // đầu tiên (cancelled/error) không bị ghi đè thành done ở cuối step.
  let runEnded = false
  const endStepRun = (status: 'done' | 'error' | 'cancelled') => {
    if (runEnded) return
    runEnded = true
    // FIX 2026-09-15 #6 (P4 — audit Team Code): wire tokensUsed THẬT của step
    // vào AgentRunRecord (trước đây tracker luôn persist null → mất số liệu).
    endAgentRun(sessionId, runId, status, `${iterations} vòng · ${totalToolCalls} tool calls`, stepTokensUsed)
  }
  // Flag session bị user hủy → cắt ngang ReAct của step + truyền xuống LLM
  const isCancelled = () => isSessionCancelled(sessionId)

  // ━━━ Phase 1c: Native Function Calling setup ━━━
  // Mode: 'off' (regex only) | 'dual' (native preferred, regex fallback) | 'strict' (native only)
  // When dual/strict: append tool schemas to system prompt (defense in depth) AND pass
  // tool definitions via LLMCallOptions.tools so NIM API includes them in the request.
  const fcMode = flagMode('ENABLE_NATIVE_FC', ['off', 'dual', 'strict']) as 'off' | 'dual' | 'strict'
  let nativeTools: LLMTool[] | undefined
  if (fcMode !== 'off') {
    // 21-c: build defs từ EFFECTIVE tools (đã áp ToolAssignment overrides — không
    // còn getToolDefinitionsForPosition(position) tĩnh) + áp description override
    // (ToolConfig — quản trị viên chỉnh mô tả tool trong prompt LLM). Fail-open.
    let toolDefs = getToolDefinitions(tools)
    try {
      const { applyDescriptionOverrides } = await import('@/lib/tool-access')
      toolDefs = await applyDescriptionOverrides(toolDefs)
    } catch { /* fail-open — mô tả mặc định */ }
    if (toolDefs.length > 0) {
      // ToolDefinition matches LLMTool shape exactly (both OpenAI-compatible)
      nativeTools = toolDefs as unknown as LLMTool[]
      // CI-3 B7 — priority THẤP NHẤT: schemas đã truyền ĐẦY ĐỦ qua API param
      // `tools` (nativeTools trên) — bản text này chỉ là defense-in-depth,
      // cắt được khi vượt budget mà không mất khả năng gọi tool
      systemBlocks.push({ name: 'toolSchemas', content: buildToolSchemasSection(toolDefs), priority: 10 })
    }
  }

  // CI-3 B7 (Task 13-e) — áp budget TỔNG rồi ghép các block thành system
  // prompt cuối (fail-open bên trong budgetPrompt: lỗi → chuỗi ghép không cut).
  // 2026-10-27 (rà soát Task 27-a): dùng trần prompt THEO TÁC VỤ của run cha
  // khi có (PROMPT ∞ → không cắt; số dương → trần riêng của tác vụ).
  const systemPrompt = budgetPromptWith(systemBlocks, ctx.promptBudgetChars, `workflow-step:${agent.name}(${position})`)

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

  // CI-3 B1 — index của step instruction (user prompt) ĐẦU TIÊN = 1; mọi message
  // index <= lastInstructionIndex KHÔNG bị nén (protected). Cập nhật khi TL recon
  // budget inject instruction mới phía dưới. Nén chỉ chèn/xóa SAU index này nên
  // vị trí tracked luôn hợp lệ.
  let lastInstructionIndex = 1

  // NOTE: Tool definitions are not passed to callLLMForAgent because it doesn't support
  // native function calling. Instead, tools are parsed from LLM text output.
  // Tool definitions are defined in prompts.ts and agents parse tool calls from their output.

  let finalContent = ''
  let iterations = 0
  let totalToolCalls = 0
  // Layer 9 P0.2 (2026-08-25): accumulate real token usage across ALL LLM
  // calls in this step's ReAct loop (each iteration = 1+ callLLMForAgent).
  // Previously tokensUsed was a literal 0 at the recordStepComplete call site
  // — severing the resource_limit detector's signal (tokenEfficiency ≡ 0).
  let stepTokensUsed = 0
  // Phase 1c metrics: track native vs fallback success rate for dual-mode validation
  let nativeToolCallCount = 0
  let regexFallbackCount = 0
  const toolCallsLog: Array<{ tool: string; args: Record<string, unknown>; result: string; duration: number; success: boolean }> = []
  // ━━━ FIX 2026-09-15 #3/#4 (P2/P3) — counters cho guards mới ━━━
  let consecutiveToolFailures = 0 // tool-fail liên tiếp → auto-consult Omega
  let omegaConsultedInStep = false // max 1 consult Omega / step (chống đệ quy tư vấn)
  let hallucinationWarnings = 0 // đếm cảnh cáo kết-quả-tool giả

  console.log(`[Workflow] Running agent: ${agent.name} (${position}) — ${step} [tools: ${tools.join(', ')}] [fc: ${fcMode}${nativeTools ? ` (${nativeTools.length} schemas)` : ''}]`)

  while (iterations < maxIterations) {
    // USER REQUEST 2026-08-31: user bấm Dừng → kết thúc step NGAY giữa các vòng
    if (isCancelled()) {
      finalContent = '⏹ Đã dừng tác vụ theo yêu cầu của bạn.'
      endStepRun('cancelled')
      break
    }
    iterations++

    // Build the prompt from conversation history
    // callLLMForAgent takes a single prompt string, so we format messages into it
    // (tính 1 LẦN trước vòng retry — giữa các attempt KHÔNG có tool nào chạy
    // nên messages không đổi, reuse prompt là an toàn)
    const formattedPrompt = formatMessagesForLLM(messages)

    // ━━━ CI-5 B6 (Task 14-d) — RETRY LLM CALL CHỈ CHO LỖI TRANSIENT ━━━
    // Bọc LLM call của step trong vòng retry ≤ WORKFLOW_STEP_LLM_MAX_RETRIES
    // (tổng 3 attempts), backoff 5s → 15s. Retry CHỈ khi lỗi là TRANSIENT của
    // hạ tầng LLM (timeout/network/429/5xx/chain-exhausted/response-rỗng —
    // isTransientLlmError); KHÔNG retry khi agent trả lời hợp lệ nhưng content
    // "fail" theo domain (đó là quyết định của agent) hay khi user đã hủy.
    // Hết retry vẫn fail → hành vi CŨ nguyên vẹn (log + emit error + break —
    // pipeline giữ nguyên policy log+skip, KHÔNG đổi PIVOT/ESCALATE).
    // Vùng KHÔNG can thiệp: compressConversation / handleOverflow /
    // scheduleAutoResume / budgetPrompt / capToolResult (CI-3 đã kiểm định).
    let result: LLMResult | null = null
    // Kết quả attempt cuối (error-result / response rỗng) — dùng sau vòng retry
    // để tái hiện ĐÚNG nhánh code cũ: error-result → fail path; response rỗng
    // không lỗi → bước kết thúc im lặng với content rỗng (như trước 14-d).
    let lastAttemptResult: LLMResult | null = null
    let lastTransientReason: string | null = null
    let llmRetriedCount = 0
    const llmMaxAttempts = WORKFLOW_STEP_LLM_MAX_RETRIES + 1

    for (let attempt = 1; attempt <= llmMaxAttempts; attempt++) {
      if (attempt > 1) {
        llmRetriedCount = attempt - 1
        const delayMs = WORKFLOW_STEP_LLM_RETRY_DELAYS_MS[Math.min(attempt - 2, WORKFLOW_STEP_LLM_RETRY_DELAYS_MS.length - 1)]
        console.warn(`[Workflow] ${agent.name} (${position}) LLM call lỗi transient (attempt ${attempt - 1}/${llmMaxAttempts}: ${lastTransientReason ?? 'unknown'}) — retry ${llmRetriedCount}/${WORKFLOW_STEP_LLM_MAX_RETRIES} sau ${delayMs}ms`)
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
        // User hủy giữa backoff → không đốt thêm LLM call; khối phân định
        // dưới xử lý theo nhánh cancelled (đúng semantics nút Dừng của file)
        if (isCancelled()) break
      }

      // Call LLM for this agent — with timeout to prevent infinite hangs
      // Edge case #1: LLM timeout → transient → retry; hết retry → emit error, break ReAct loop
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
          // USER REQUEST 2026-08-31: chuỗi xoay vòng key LLM dừng ngay khi user hủy
          abortCheck: isCancelled,
          ...(nativeTools && nativeTools.length > 0
            ? { tools: nativeTools, tool_choice: 'auto' as const }
            : {}),
        }
      )

      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<LLMResult>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`LLM call timed out after ${AGENT_STEP_TIMEOUT_MS}ms`)), AGENT_STEP_TIMEOUT_MS)
      })

      try {
        const r = await Promise.race([llmCallPromise, timeoutPromise])
        lastAttemptResult = r
        if (r && (r.content || (r.tool_calls && r.tool_calls.length > 0))) {
          // THÀNH CÔNG — có output thật (content hoặc tool_calls; result kèm
          // error nhưng CÓ content vẫn dùng content — đúng semantics code cũ)
          result = r
          break
        }
        if (r && !r.error) {
          // Response rỗng KHÔNG kèm lỗi hạ tầng (200 nhưng không content lẫn
          // tool_calls) — CI-5 B6 coi là transient của hạ tầng: retry. Hết
          // retry → khối phân định giữ NGUYÊN nhánh cũ (kết thúc im lặng).
          lastTransientReason = 'LLM trả về response rỗng (không content, không tool_calls, không error)'
          continue
        }
        // r.error && !r.content — lỗi hạ tầng của chuỗi LLM (content rỗng)
        const errMsg = r ? r.error ?? 'LLM call failed' : 'LLM trả về null'
        lastTransientReason = errMsg
        if (!isTransientLlmError(errMsg)) {
          // Non-transient (auth/permission/aborted...) — KHÔNG retry, xử lý
          // fail NGAY ở khối phân định như hành vi cũ
          break
        }
        // Transient → vòng kế retry (hết retry thì fail path cũ với errMsg)
      } catch (timeoutErr) {
        // Promise.race reject = LLM call timeout — luôn transient → retry
        lastAttemptResult = null
        lastTransientReason = timeoutErr instanceof Error ? timeoutErr.message : 'LLM call timed out'
      } finally {
        // Always clear timeout to prevent resource leak
        if (timeoutId) clearTimeout(timeoutId)
      }
    }

    // ===== Phân định kết quả — bảo toàn semantics code cũ =====
    // USER REQUEST 2026-08-31: user bấm Dừng trong lúc LLM đang chạy (kể cả
    // giữa backoff retry) → nhãn cancelled, KHÔNG phải error
    if (isCancelled()) {
      finalContent = '⏹ Đã dừng tác vụ theo yêu cầu của bạn.'
      endStepRun('cancelled')
      break
    }
    // Response rỗng không lỗi sau khi hết retry → GIỮ NGUYÊN hành vi cũ:
    // bước kết thúc im lặng với content rỗng (không emit error)
    if (!result && lastAttemptResult && !lastAttemptResult.error) {
      result = lastAttemptResult
    }
    if (!result) {
      // Mọi attempt đều thất bại hạ tầng (timeout throw / error-result) —
      // ĐÚNG hành vi cũ: log + emit error + break (pipeline log+skip)
      const errMsg = lastAttemptResult?.error ?? lastTransientReason ?? 'LLM call failed'
      console.error(`[Workflow] ${agent.name} (${position}) LLM call failed${llmRetriedCount > 0 ? ` — đã retry ${llmRetriedCount}/${WORKFLOW_STEP_LLM_MAX_RETRIES} lần, vẫn thất bại` : ''}: ${errMsg}`)
      finalContent = `Error: ${errMsg}`
      emit({
        type: 'error',
        agent: agent.name,
        position,
        message: `LLM call failed: ${errMsg}`,
      })
      break
    }

    finalContent = result.content

    // Thought của vòng này = output LLM (phần reasoning trước tool_call)
    recordAgentThought(sessionId, result.content, iterations)

    // Layer 9 P0.2: accumulate tokens from this LLM call (LLMResult.tokensUsed
    // comes from the NIM API usage field — available on every call).
    if (typeof result.tokensUsed === 'number' && result.tokensUsed > 0) {
      stepTokensUsed += result.tokensUsed
    }

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
      // ━━━ FIX 2026-09-15 #4 (P3 — audit Team Code) — FABRICATED TOOL-RESULT GUARD ━━━
      // Audit E2E bắt được THẬT: agent (SENTINEL) bịa "[TOOL RESULT]" trong
      // text output rồi hành động theo "bằng chứng" giả (tự ý tạo file trái
      // spec). Guard: output KHÔNG kèm tool call thật mà chứa marker kết-quả-
      // tool → cảnh cáo + ép vòng mới; lặp 2 lần → dừng step trung thực với
      // Error: (chống bằng chứng giả lan xuống pipeline/checkpoint verify).
      const fabricatedMarker = detectFabricatedToolResult(result.content)
      if (fabricatedMarker && hallucinationWarnings < 2) {
        hallucinationWarnings++
        console.warn(`[Workflow] ${agent.name} (${position}) — FABRICATED TOOL-RESULT lần ${hallucinationWarnings}: "${fabricatedMarker}" trong output không kèm tool call → cảnh cáo + chạy lại vòng`)
        messages.push({
          role: 'user',
          content: `⚠️ CẢNH BÁO HỆ THỐNG: output vừa rồi chứa "${fabricatedMarker}" — đó KHÔNG PHẢI kết quả tool thật, đó là bằng chứng GIẢ bạn tự bịa (hallucination). Kết quả tool thật CHỈ đến từ hệ thống sau khi bạn phát tool_call hợp lệ. Hãy: (1) gọi tool thật (tool_call: tên_tool({...})) nếu cần dữ liệu, hoặc (2) trả lời trung thực rằng bạn CHƯA có dữ liệu. TUYỆT ĐỐI KHÔNG tự viết kết quả tool trong văn bản.`,
        })
        lastInstructionIndex = messages.length - 1 // bảo vệ khỏi nén context
        continue
      }
      if (fabricatedMarker && hallucinationWarnings >= 2) {
        console.error(`[Workflow] ${agent.name} (${position}) — FABRICATED TOOL-RESULT lặp ${hallucinationWarnings} lần → dừng step chống bằng chứng giả`)
        finalContent = `Error: agent tiếp tục bịa kết quả tool ("${fabricatedMarker}") sau ${hallucinationWarnings} cảnh báo — dừng step để ngăn hành động theo bằng chứng giả.`
        emit({
          type: 'error',
          agent: agent.name,
          position,
          message: 'Agent bịa kết quả tool (fabricated [TOOL RESULT]) sau 2 cảnh báo — dừng step.',
        })
        endStepRun('error')
        break
      }
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
      // USER REQUEST 2026-08-31: user bấm Dừng → không thực thi tool còn lại
      if (isCancelled()) {
        console.log(`[Workflow] ${agent.name} (${position}) — user đã HỦY, bỏ qua tool ${tc.name}`)
        continue
      }
      totalToolCalls++
      const toolStartTime = Date.now()

      // TASK 41 — abs path server-resolved của file tool đang gọi (theo workspace
      // root THẬT của server). UI (handleAIToolEvent) dùng absPath này thay vì đoán
      // abs path từ args RAW (tương đối) + workspaceRoot localStorage (có thể lệch
      // root với server → auto-open toast đỏ "Không đọc được file"). Fail-open:
      // undefined → UI giữ hành vi fallback cũ.
      let tcAbsPath: string | undefined
      {
        const tcArgs = (tc.args || {}) as Record<string, unknown>
        const tcRawPath = typeof tcArgs.path === 'string' ? tcArgs.path
          : typeof tcArgs.filePath === 'string' ? tcArgs.filePath : ''
        if (tcRawPath) {
          try { tcAbsPath = await resolveUiAbsPath(tcRawPath) } catch { /* bỏ qua */ }
        }
      }

      emit({
        type: 'tool_call',
        agent: agent.name,
        position,
        tool: tc.name,
        detail: JSON.stringify(tc.args).slice(0, 200),
        ...(tcAbsPath ? { absPath: tcAbsPath } : {}),
      })

      // ===== FIX (R2-c #1) — DEPTH GUARD: tool huy động bị từ chối tại executor =====
      const depthGuardHit = WF_DEPTH_GUARD_TOOLS.has(tc.name)
      if (depthGuardHit) {
        console.warn(`[Workflow] DEPTH-GUARD: từ chối tool "${tc.name}" của ${agent.name} (${position}) — không lồng delegation/team huy động bên trong workflow code team. Agent phải tự thực hiện bằng tools thi công.`)
      }

      // ===== v2.1 Phase 4.1 — Auto-checkpoint BEFORE risky ops =====
      // Spec line 252: "Auto-checkpoint BEFORE risky ops (file_edit/file_delete/
      // file_multi_edit/git_commit/run_tests) in workflow-engine.ts executeTool
      // calls — wrap with try/finally".
      //
      // Strategy: if the tool being called is in RISKY_OPS, take a differential
      // Neo4j checkpoint + fs-checkpoint BEFORE calling executeTool. The checkpoint
      // is fire-and-forget (errors swallowed) so a checkpoint failure never blocks
      // the actual operation.
      if (!depthGuardHit && RISKY_OPS.has(tc.name)) {
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

      // Agent context cho Agent Activity Log (Terminal echo — user request 2026-08-27)
      // DELEGATION CONTRACT (fix 2026-09-12):
      //  · todo_write → inject sessionId + runId của step run (mirror goal-loop
      //    CI-2): todos agent-initiated gắn đúng phiên chat + run của step —
      //    không còn rơi scope 'default' vô hình (panel Thought Process hiển thị).
      //  · context.runId → delegate_task của MEGATRON đọc làm parentRunId.
      const wfToolArgs: Record<string, unknown> = { ...tc.args }
      if (tc.name === 'todo_write' && sessionId && (!wfToolArgs.sessionId || wfToolArgs.sessionId === sessionId)) {
        wfToolArgs.sessionId = wfToolArgs.sessionId || sessionId
        if (runId && !wfToolArgs.runId) wfToolArgs.runId = runId
      }
      const toolResult = depthGuardHit
        ? {
            success: false,
            result: {
              error: `TỪ CHỐI (depth-guard workflow): tool "${tc.name}" không khả dụng bên trong workflow code team — không được huy động sub-agent/team lồng nhau. Hãy TỰ THỰC HIỆN step hiện tại bằng tools thi công (file_read/file_edit/shell/run_tests/lint/type_check...).`,
            },
          }
        : await executeTool(tc.name, wfToolArgs, { agentName: agent.name, sessionId, runId })
      const toolDuration = Date.now() - toolStartTime

      // TOKEN ACCOUNTING (fix review 2026-09-08): escalate_problem (Omega
      // consult) tiêu token thật — cộng vào stepTokensUsed để metrics đúng
      // (goal loop đã đếm từ trước; workflow engine thì chưa).
      if (toolResult.result && typeof toolResult.result === 'object') {
        const innerTokens = (toolResult.result as { tokensUsed?: unknown }).tokensUsed
        if (typeof innerTokens === 'number' && innerTokens > 0) {
          stepTokensUsed += innerTokens
        }
      }

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
        ...(tcAbsPath ? { absPath: tcAbsPath } : {}),
      })

      // ━━━ FIX 2026-09-15 #3 (P2 — audit Team Code) — TOOL-FAILURE THRESHOLD GUARD ━━━
      // 3 tool fail LIÊN TIẾP (không tính depth-guard pedagogical rejection) →
      // AUTO-CONSULT Omega giữa step (mirror AUTO-ESCALATE goal-loop): advisory
      // inject vào conversation dẫn đường các vòng còn lại — đúng yêu cầu
      // "gặp lỗi gửi vấn đề tới Omega trong QUÁ TRÌNH thực thi". Max 1
      // consult/step; reset counter sau consult; fail-open tuyệt đối.
      if (!toolResult.success && !depthGuardHit) {
        consecutiveToolFailures++
      } else if (toolResult.success) {
        consecutiveToolFailures = 0
      }
      if (
        consecutiveToolFailures >= WF_TOOL_FAIL_ESCALATE_THRESHOLD &&
        !omegaConsultedInStep &&
        !isCancelled()
      ) {
        const failStreak = consecutiveToolFailures
        omegaConsultedInStep = true
        consecutiveToolFailures = 0
        try {
          const { consultOmega } = await import('@/lib/omega-orchestrator')
          const recentFails = toolCallsLog
            .filter(e => !e.success)
            .slice(-5)
            .map(e => `- ${e.tool}: ${e.result.slice(0, 120)}`)
            .join('\n')
          const consult = await consultOmega({
            problem: `Agent "${agent.name}" (vị trí ${position}, step "${step}") của Code Team gặp ${failStreak} tool failures LIÊN TIẾP khi đang thực thi — nguy cơ bế tắc/vòng lặp thất bại. Tool fail gần nhất:\n${recentFails || '(không rõ)'}`,
            context: `Step task: ${prompt.slice(0, 400)}\nSession: ${sessionId}\nĐã chạy ${iterations} vòng / ${totalToolCalls} tool calls trong step này.`,
            attempted: `Tool đã thử trong step: ${[...new Set(toolCallsLog.map(e => e.tool))].join(', ')}`,
            callingAgent: agent.name,
            severity: 'medium',
            autoTriggered: true,
            abortCheck: isCancelled,
          })
          if (consult.success && consult.text) {
            if (typeof consult.tokensUsed === 'number' && consult.tokensUsed > 0) {
              stepTokensUsed += consult.tokensUsed
            }
            messages.push({
              role: 'user',
              content: `💡 TƯ VẤN TỪ OMEGA ORCHESTRATOR (auto-escalate sau ${failStreak} tool fail liên tiếp — HÃY LÀM THEO, đổi cách tiếp cận):\n${consult.text.slice(0, 1600)}`,
            })
            lastInstructionIndex = messages.length - 1 // bảo vệ khỏi nén context
            emit({
              type: 'omega_escalation',
              agent: agent.name,
              position,
              step,
              advisory: consult.text.slice(0, 800),
              reason: `${failStreak} tool fail liên tiếp trong step ${step}`,
              tokensUsed: consult.tokensUsed,
            })
            console.log(`[Workflow] AUTO-ESCALATE (tool-failure guard): ${agent.name} (${position}) — Omega advisory nhận (${consult.tokensUsed} tokens), inject vào vòng ${iterations + 1}`)
          } else {
            console.warn(`[Workflow] AUTO-ESCALATE (tool-failure guard): consultOmega không trả advisory (fail-open): ${consult.error ?? 'không rõ'}`)
          }
        } catch (guardErr) {
          console.warn('[Workflow] AUTO-ESCALATE (tool-failure guard) thất bại (fail-open):', guardErr instanceof Error ? guardErr.message : String(guardErr))
        }
      }

      // Add tool result to conversation
      // CI-3 B1 — cap tool result ~4k chars TRƯỚC khi push (pattern goal-loop):
      // tool output lớn (file_read/shell/run_tests) làm ReAct loop phình vô hạn.
      // Result NHỎ giữ nguyên shape object như cũ (không đổi hành vi); result LỚN
      // → envelope JSON HỢP LỆ {tool, success, result: {_truncated,
      // _originalChars, _note, head, tail}} — content LUÔN parse được cho
      // formatMessagesForLLM + heuristic nén phía dưới.
      // ROUND-27 FIX V3 — trước đây capToolResult splice marker vào giữa chuỗi
      // JSON rồi nhét result thành STRING chứa mảnh JSON vỡ (message hợp lệ nhưng
      // LLM không thể trích xuất cấu trúc result) — cùng lớp bug FIX B round-26,
      // bỏ sót đường workflow. Giờ 3 vòng lặp (goal-loop / sub-agent /
      // workflow) dùng CHUNG một envelope của context-compression.
      let entrySerialized: string
      try {
        entrySerialized = JSON.stringify({ tool: tc.name, success: toolResult.success, result: toolResult.result })
      } catch {
        // result circular/không serialize được → String() an toàn (kết quả vẫn là
        // JSON hợp lệ — trước đây nhánh này có thể throw lần 2 ngay trong push)
        entrySerialized = JSON.stringify({ tool: tc.name, success: toolResult.success, result: String(toolResult.result) })
      }
      messages.push({
        role: 'tool',
        content: entrySerialized.length <= TOOL_RESULT_MAX_CHARS
          ? entrySerialized
          : truncateToolMessageJson(
              { tool: tc.name, success: toolResult.success, result: toolResult.result },
              entrySerialized,
              TOOL_RESULT_MAX_CHARS,
            ),
        tool_call_id: tc.id,
      })
    }

    // ===== CI-3 B1 — Rolling context compression (digest) =====
    // Chạy sau MỖI iteration (đã push đủ tool results), TRƯỚC overflow check:
    // đo tổng chars của segment nén được (sau step-instruction cuối, trừ
    // KEEP_RECENT_MESSAGES message gần nhất); vượt 50k → nén thành 1 digest
    // message (goal-loop pattern). KHÔNG nén khi segment < 3 cặp message (6
    // messages). FAIL-OPEN TUYỆT ĐỐI: lỗi nén KHÔNG BAO GIỜ làm fail step.
    try {
      const compressStart = lastInstructionIndex + 1
      const compressEnd = messages.length - KEEP_RECENT_MESSAGES
      if (compressEnd > compressStart) {
        let segmentChars = 0
        for (let mi = compressStart; mi < compressEnd; mi++) segmentChars += messages[mi].content.length
        if (segmentChars >= COMPRESS_THRESHOLD_CHARS) {
          const comp = await compressConversation({
            messages,
            protectedStartIndex: lastInstructionIndex,
            keepRecent: KEEP_RECENT_MESSAGES,
            // workflow không giữ evidence log như goal-loop → heuristic fallback
            // sẽ suy xuất từ chính transcript (tool JSON có sẵn tool/success)
            minCompressibleMessages: 6, // < 3 cặp (assistant + tool reply) → không nén
            llmContext: 'workflow-context-compression',
            onTokens: (t) => { stepTokensUsed += t },
            // CI-3 B2 (Task 13-b): lưu digest vào Kho Context — runId = sessionId
            // workflow (cùng scope step-todo CI-2) để context_recall truy hồi
            // trọn vẹn 1 workflow session (fail-open bên trong).
            archive: { runId: sessionId, sessionId, agentName: agent.name },
          })
          if (comp) {
            console.log(`[Workflow] ${agent.name} (${position}) rolling digest: -${comp.savedChars} chars (${comp.method})`)
          }
        }
      }
    } catch (compErr) {
      console.warn(`[Workflow] ${agent.name} (${position}) rolling digest FAILED (non-blocking): ${compErr instanceof Error ? compErr.message : String(compErr)}`)
    }

    // ===== v2.1 Phase 5.6 — Context overflow detection (Appendix C.4) =====
    // Strategy: after every tool iteration, estimate the conversation's
    // token count. If it exceeds CONTEXT_OVERFLOW_THRESHOLD (80k default)
    // AND ENABLE_SESSION_RESUME is on:
    //   CI-3 B5 (Task 13-d) — DIGEST-FIRST: chạy handleOverflow TRƯỚC — nếu
    //   digest kéo context xuống dưới ngưỡng → KHÔNG pause, ReAct loop chạy
    //   tiếp ("resume" nhanh nhất là không cần pause). Digest không cứu được
    //   → pause như cũ (save state → pause → sentinel → break) NHƯNG tự động
    //   resume in-process sau 1 khoảng ngắn — ĐÚNG code path POST
    //   /api/workflow/resume, không cần API thủ công; tối đa
    //   MAX_AUTO_RESUME_PER_SESSION (3) lần mỗi session, vượt → pause thật
    //   chờ can thiệp thủ công. TOÀN BỘ fail-open: lỗi bất kỳ trong
    //   auto-resume path → rơi về hành vi pause cũ.
    const currentTokens = estimateTokens(messages)
    if (
      detectContextOverflow(currentTokens, stepOverflowThreshold) &&
      isFlagEnabled('ENABLE_SESSION_RESUME')
    ) {
      let overflowOutcome: HandleOverflowResult | null = null
      try {
        overflowOutcome = await handleOverflow({
          messages,
          currentTokens,
          threshold: stepOverflowThreshold,
          sessionId,
          agentName: agent.name,
          position,
          protectedStartIndex: lastInstructionIndex,
          onTokens: (t) => { stepTokensUsed += t },
          archive: { runId: sessionId, sessionId, agentName: agent.name },
        })
      } catch (overflowErr) {
        // Fail-open tuyệt đối — lỗi bất ngờ trong overflow path → hành vi
        // pause cũ nguyên vẹn (pause chờ thủ công, KHÔNG auto-resume).
        console.error(`[Workflow] ${agent.name} (${position}) handleOverflow FAILED — falling back to legacy manual pause: ${overflowErr instanceof Error ? overflowErr.message : String(overflowErr)}`)
      }

      if (overflowOutcome?.action === 'continue') {
        // Digest đã tự cứu: context giờ nằm dưới ngưỡng — KHÔNG pause, KHÔNG
        // break; ReAct loop chạy tiếp với lịch sử đã nén (log chi tiết đã in
        // bên trong handleOverflow — "overflow → rolling digest giảm về ~N
        // tokens — tiếp tục không pause").
      } else {
        console.warn(`[Workflow] ${agent.name} (${position}) context overflow detected: ~${currentTokens} tokens > ${CONTEXT_OVERFLOW_THRESHOLD} threshold — pausing session ${sessionId} for resume handoff${overflowOutcome?.digestMethod ? ` (digest ${overflowOutcome.digestMethod} tiết kiệm −${overflowOutcome.savedChars} chars nhưng vẫn vượt ngưỡng)` : ''}`)
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
        let autoResumeNumber: number | null = null
        try {
          await saveWorkflowSession(
            sessionId,
            position,
            step, // taskDescription placeholder — caller can update via save on next call
            overflowState,
            'active',
          )
          const pauseResult = await pauseWorkflowSession(sessionId, 'context overflow')
          // CI-3 B5 — contextOverflowCount AUTHORITATIVE từ pause result (chống
          // race với process khác): chỉ auto-resume khi 1 ≤ count ≤ cap N;
          // vượt cap → pause thật chờ can thiệp thủ công.
          if (
            pauseResult.success &&
            pauseResult.contextOverflowCount >= 1 &&
            pauseResult.contextOverflowCount <= MAX_AUTO_RESUME_PER_SESSION
          ) {
            autoResumeNumber = pauseResult.contextOverflowCount
          }
        } catch (persistErr) {
          // Never crash the workflow because state persistence failed — log + continue.
          autoResumeNumber = null // fail-open: persist lỗi → không auto-resume
          console.error(`[Workflow] Phase 5.6 state persist failed (non-blocking): ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`)
        }
        // CI-3 B5 — auto-resume in-process (không cần POST thủ công); mọi lỗi
        // bên trong scheduler chỉ log — KHÔNG BAO GIỜ crash step.
        if (autoResumeNumber !== null) {
          scheduleAutoResume(sessionId, autoResumeNumber, agent.name, position)
        } else {
          console.warn(`[Workflow] session ${sessionId} đã đạt/vượt cap ${MAX_AUTO_RESUME_PER_SESSION} lần auto-resume (hoặc persist lỗi) — pause THẬT chờ can thiệp thủ công: POST /api/workflow/resume?sessionId=${sessionId}`)
        }
        // Sentinel marker — parent workflow/UI detect overflow qua marker này
        // (giữ nguyên format cũ; auto-resume chỉ APPEND ghi chú phía sau).
        finalContent += `\n\n[CONTEXT_OVERFLOW:session=${sessionId}] Conversation reached ~${currentTokens} tokens (> ${CONTEXT_OVERFLOW_THRESHOLD} threshold). State persisted; call POST /api/workflow/resume?sessionId=${sessionId} to continue.${autoResumeNumber !== null ? ` (auto-resume #${autoResumeNumber} đã lên lịch — session sẽ tự ACTIVE lại)` : ''}`
        emit({
          type: 'error',
          agent: agent.name,
          position,
          message: `Context overflow (~${currentTokens} tokens) — session ${sessionId} paused for resume handoff${autoResumeNumber !== null ? ` — auto-resume #${autoResumeNumber} scheduled` : ''}`,
        })
        break
      }
    }

    // ===== Recon budget enforcement for TL/analyze =====
    // When TL is in the analyze (routing) step and has done 5+ iterations of
    // recon (file reading), inject a system message forcing it to produce the
    // routing JSON now. Without this, TL can spend all 10 iterations reading
    // files and never emit the routing decision — falling back to defaults.
    if (position === 'TL' && step === 'analyze' && iterations >= 5 && toolCalls.length > 0) {
      console.log(`[Workflow] ${agent.name} recon budget: ${iterations} iterations done — injecting "produce routing now" message`)
      messages.push({
        role: 'user',
        content: `⚠️ RECON BUDGET: Bạn đã đọc đủ code (iteration ${iterations}/${maxIterations}). NGAY BÂY GIỜ, hãy emit routing JSON với format:\n\`\`\`json\n{\n  "mode": "A|B|C",\n  "tier": 1|2|3,\n  "score": <3-9>,\n  "reasoning": "<giải thích dựa trên code đã đọc>",\n  "targetFiles": ["<files cần sửa>"],\n  "filesInspected": ["<files đã đọc>"],\n  "riskLevel": "low|medium|high",\n  "executionPlan": [{"step":1,"description":"...","targetFiles":["..."],"agent":"G1|G2-A|G2-B|G3|TL","risk":"low|medium|high"}],\n  "parts": [{"name":"...","type":"visual|backend","description":"...","dependency":[]}],\n  "spec": "<spec chi tiết>"\n}\n\`\`\`\nKHÔNG gọi tool thêm — chỉ output JSON.`,
      })
      // CI-3 B1 — instruction mới trở thành protected head của segment nén kế tiếp
      lastInstructionIndex = messages.length - 1
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
  console.log(`[Workflow] ${agent.name} done: ${iterations} iterations, ${totalToolCalls} tool calls, ${stepTokensUsed} tokens, ${Date.now() - stepStartTime}ms [${fcMetrics}]`)

  // 2026-08-29 — AUTO-TODO TRACKING: đánh dấu step todo hoàn thành/thất bại.
  // finalContent bắt đầu bằng "Error:" = LLM fail hoàn toàn (branch break ở trên).
  await upsertStepTodo(finalContent.startsWith('Error:') ? 'failed' : 'completed')

  // Thought Process tracking (2026-08-31) — đóng run của step này
  // (idempotent: nếu đã đóng là 'cancelled' thì giữ nguyên)
  const stepFinalStatus = finalContent.startsWith('Error:') ? 'error' as const : 'done' as const
  endStepRun(stepFinalStatus)

  // ━━━ ROUND-37 V3.1 — EPISODIC CONSOLIDATE: lỗi step thành bài học ━━━
  // Trước đây chỉ goal-loop ghi episode; step Code Team fail KHÔNG bao giờ
  // trở thành ErrorOccurrence/Lesson. Giờ mỗi step ghi 1 episode: toolCallsLog
  // làm evidence (recorder tự classify root cause + sinh lesson từ lỗi đã
  // resolve), appliedLessonIds từ PRE-ACT được validate theo outcome step.
  // Skip step thuần LLM thành công (0 tool call) — noise không dữ liệu học.
  try {
    const toolFailures = toolCallsLog.filter(e => !e.success).length
    if (toolCallsLog.length > 0 || stepFinalStatus === 'error') {
      const { recordAgentEpisode, mapRunOutcome } = await import('@/lib/episodic-memory/agent-brain')
      recordAgentEpisode({
        family: 'code-team',
        agentName: `${agent.name} (${position}/${step})`,
        goal: prompt.slice(0, 500) || `Step ${position}/${step}`,
        sessionId,
        outcome: isCancelled()
          ? 'ABANDONED'
          : mapRunOutcome({ status: stepFinalStatus, toolFailures }),
        stopReason: isCancelled() ? 'cancelled' : stepFinalStatus === 'error' ? 'error' : 'complete',
        cycles: iterations,
        tokensUsed: stepTokensUsed,
        appliedLessonIds: stepAppliedLessonIds,
        toolEvidence: toolCallsLog.map(e => ({
          tool: e.tool,
          success: e.success,
          text: `${e.args ? JSON.stringify(e.args).slice(0, 150) : ''} ${e.result}`.slice(0, 600),
        })),
      })
    }
  } catch (epErr) {
    console.warn('[Workflow] V3.1 episodic record failed (non-blocking):', epErr instanceof Error ? epErr.message : String(epErr))
  }

  // Layer 9 P0.2: expose the step's real token usage to the caller
  // (runWorkflow passes it down to metricsCollector.recordStepComplete).
  return { content: finalContent, duration: Date.now() - stepStartTime, tokensUsed: stepTokensUsed }
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
): Promise<{ decision: 'CONTINUE' | 'PIVOT' | 'ESCALATE'; reasoning: string; updatedSpec?: string; evidence?: string[] }> {
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

  const verifyPrompt = `Bạn là TL (MEGATRON). Verify checkpoint sau ${latestWorklog.agentName} (${latestWorklog.position}).

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
${latestWorklog.toolCallsLog && latestWorklog.toolCallsLog.length > 0 ? `Tool calls THẬT của agent: ${latestWorklog.toolCallsLog.length} lần (${latestWorklog.toolCallsLog.filter(t => t.success).length} OK / ${latestWorklog.toolCallsLog.filter(t => !t.success).length} fail):
${latestWorklog.toolCallsLog.slice(-8).map(t => `- ${t.tool} ${t.success ? '✓' : '✗'} (${Math.round(t.duration / 1000)}s): ${t.result.slice(0, 100)}`).join('\n')}` : 'Tool calls THẬT: (agent KHÔNG gọi tool nào — mọi tuyên bố chỉ là khai báo văn bản, chưa có bằng chứng thực tế)'}

━━━ QUYẾT ĐỊNH ━━━
Dựa trên worklog + TOOL CALLS THẬT phía trên (bằng chứng thực tế), quyết định:
- CONTINUE: Progress đúng kế hoạch, tiếp tục pipeline — PHẢI liệt kê evidence từ tool calls/worklog
- PIVOT: Direction cần thay đổi (approach sai, requirement mới)
- ESCALATE: Cần user input (blocker, ambiguous requirement)

Output JSON trong markdown code block:
\`\`\`json
{
  "decision": "CONTINUE|PIVOT|ESCALATE",
  "reasoning": "<lý do>",
  "evidence": ["<bằng chứng THẬT: tool + kết quả rút gọn dẫn chứng>"],
  "updatedSpec": "<nếu PIVOT — spec mới, ngược lại null>",
  "issues": ["<vấn đề phát hiện>"]
}
\`\`\``

  // Build system prompt for TL checkpoint verify — include skills injection
  // CI-3 B7 (Task 13-e): áp budget tổng như step prompt (persona cao nhất —
  // skills thấp hơn; tổng ~21k thường dưới 24k → no-op, chỉ kích hoạt khi user
  // hạ SYSTEM_PROMPT_BUDGET_CHARS)
  const verifySystemPrompt = budgetPromptWith(
    [
      { name: 'persona', content: getAgentPrompt('TL'), priority: 100 },
      ...(await (async () => {
        // 2026-09-01 — lọc skill bị chặn cho TL (verify checkpoint) như step thường
        if (ctx.skillsRaw && ctx.skillsRaw.length > 0) {
          const t = await loadEnabledSkillsForAgent('TL', ctx.skillsRaw)
          return t ? [{ name: 'skills', content: t, priority: 20 }] : []
        }
        return ctx.skillsContext ? [{ name: 'skills', content: ctx.skillsContext, priority: 20 }] : []
      })()),
    ],
    // 2026-10-27 (rà soát Task 27-a): trần prompt theo tác vụ của run cha
    ctx.promptBudgetChars,
    'workflow-checkpoint-verify:TL',
  )

  // Call LLM for checkpoint verification — with shorter timeout (30s)
  // Edge case #1: LLM timeout → fallback to rule-based decision
  const verifyCallPromise = callLLMForAgent(
    verifyPrompt,
    { provider: agentDef.provider, model: agentDef.model },
    verifySystemPrompt,
    { agentId: 'TL-verify', agentName: 'MEGATRON' }
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

  // ━━━ FIX 2026-09-15 #5 (P3 — audit Team Code) — VERIFY EVIDENCE GUARD ━━━
  // Mirror VERIFY EVIDENCE GUARD của goal-loop: quyết định CONTINUE mà KHÔNG có
  // bằng chứng tool nào (evidence rỗng) + worklog còn issue high/critical chưa
  // fix → hạ xuống PIVOT (yêu cầu đổi hướng/tái kiểm định — không cho qua cửa
  // chỉ bằng lời khai). CONTINUE không kèm evidence nhưng cũng không có issue
  // nặng → giữ decision, ghi chú cảnh báo để theo dõi (tránh hạ nặng oan các
  // step thuần phân tích không cần tool).
  const evidence = parsed?.evidence ?? []
  const hasUnfixedHigh =
    latestWorklog.issues.some(i => (i.severity === 'critical' || i.severity === 'high') && !i.fixApplied) ||
    (latestWorklog.unfixedBugs || []).some(b => b.severity === 'critical' || b.severity === 'high')
  let verifyDecision = parsed?.decision || ruleBasedDecision
  let verifyReasoning = parsed?.reasoning || `Auto-verify: ${ruleBasedDecision} based on worklog issues`
  if (verifyDecision === 'CONTINUE' && evidence.length === 0 && hasUnfixedHigh) {
    verifyDecision = 'PIVOT'
    verifyReasoning += ' [EVIDENCE GUARD: CONTINUE không kèm bằng chứng tool trong khi còn issue high/critical chưa fix — hạ PIVOT]'
    console.warn(`[Workflow] VERIFY EVIDENCE GUARD: hạ CONTINUE → PIVOT (evidence rỗng + issue nặng chưa fix) [session ${sessionId.slice(0, 12)}]`)
  } else if (verifyDecision === 'CONTINUE' && evidence.length === 0 && latestWorklog.completed.length > 0) {
    verifyReasoning += ' (⚠️ TL chưa liệt kê bằng chứng tool — evidence rỗng, theo dõi sát bước tiếp theo)'
    console.warn(`[Workflow] VERIFY EVIDENCE GUARD: CONTINUE với evidence rỗng (agent khai báo ${latestWorklog.completed.length} việc) [session ${sessionId.slice(0, 12)}]`)
  }

  return {
    decision: verifyDecision,
    reasoning: verifyReasoning,
    updatedSpec: parsed?.updatedSpec,
    evidence,
  }
}

// ==================== HELPERS ====================

/**
 * Build the initial prompt for TL's routing analysis.
 * Includes chat history + current request.
 */
async function buildTLPrompt(userRequest: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  // Include last 10 messages for context
  const history = messages
    .slice(-10)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n')

  // Inject workspace context so TL knows the project structure before recon
  let workspaceContext = ''
  try {
    // buildWorkspaceContext đã import tĩnh ở đầu file (line ~55) — path cũ
    // './workspace-context' sai (module nằm ở @/lib/workspace/workspace-context);
    // trả về { text, root } — lấy .text (pattern giống dòng ~1369)
    const wsCtx = await buildWorkspaceContext()
    workspaceContext = wsCtx.text
  } catch {
    // Fallback: minimal context nếu buildWorkspaceContext lỗi
    workspaceContext = `Workspace root: ${process.env.OPENCODE_WORKSPACE || process.cwd()}`
  }

  return `${workspaceContext}

━━━ NHIỆM VỤ ━━━
Chat history:
${history}

Yêu cầu hiện tại: ${userRequest}

━━━ QUY TRÌNH THỰC HIỆN (LÀM THEO THỨ TỰ) ━━━

BƯỚC 1 — RECON (TRINH SÁT CODEBASE):
Đọc codebase để hiểu context thực tế trước khi routing. Dùng tools theo thứ tự:
  a) file_list({"path": ".", "depth": 2}) — xem cấu trúc thư mục
  b) grep({"pattern": "<từ khóa liên quan>", "path": "src", "mode": "files"}) — tìm file liên quan đến task
  c) file_read({"path": "<file quan trọng>", "limit": 100}) — đọc nội dung file cần sửa (TỐI ĐA 100 dòng)
  d) Lặp lại b-c tối đa 2-3 lần — ĐỦ hiểu rồi thì emit JSON

  ⚠️ BẮT BUỘC: Nếu task có thể là Mode B (backend) hoặc Mode C (hybrid) hoặc tier ≥ 2, PHẢI đọc ít nhất 1-2 file trước khi emit routing JSON. Không được routing "mù" (chỉ dựa trên text của user).
  ⚠️ GIỚI HẠN: Tổng số file_read ≤ 3. Đọc quá nhiều → context quá lớn → LLM timeout → không emit được JSON. Đọc ĐỦ → emit JSON NGAY.

BƯỚC 2 — ROUTING DECISION:
Sau khi recon xong, output JSON trong markdown code block với format:
\`\`\`json
{
  "mode": "A|B|C",
  "tier": 1|2|3,
  "score": <3-9>,
  "reasoning": "<giải thích — bao gồm phát hiện khi đọc code>",
  "targetFiles": ["src/path/to/file1.ts", "src/path/to/file2.tsx"],
  "filesInspected": ["src/path/to/inspected1.ts"],
  "riskLevel": "low|medium|high",
  "executionPlan": [
    { "step": 1, "description": "<mô tả>", "targetFiles": ["<file>"], "agent": "G1|G2-A|G2-B|G3|TL", "risk": "low|medium|high" }
  ],
  "parts": [
    { "name": "<tên part>", "type": "visual|backend", "description": "<mô tả>", "dependency": [] }
  ],
  "spec": "<chi tiết spec — dựa trên code thực tế đã đọc>"
}
\`\`\`

Bắt đầu với BƯỚC 1 (RECON) ngay — gọi file_list hoặc grep trước.`
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
        return buildRoutingDecision(parsed)
      }
    }

    // Strategy 2: Try to find raw JSON object
    const rawMatch = findBalancedJsonUtil(output, '"mode"')
    if (rawMatch) {
      const parsed = JSON.parse(rawMatch)
      if (parsed.mode && parsed.tier) {
        return buildRoutingDecision(parsed)
      }
    }
  } catch (err) {
    console.warn('[Workflow] Failed to parse routing decision:', err)
  }

  return null
}

/**
 * Build a RoutingDecision from a parsed LLM JSON object, extracting the new
 * recon-aware fields (targetFiles, filesInspected, riskLevel, executionPlan)
 * introduced in the multi-file-read + planning enhancement.
 */
function buildRoutingDecision(parsed: Record<string, any>): RoutingDecision {
  const validRiskLevels = ['low', 'medium', 'high']
  const validAgents = ['TL', 'G1', 'G2-A', 'G2-B', 'G3']
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
    // New recon-aware fields (optional — populated when TL does file recon before routing)
    targetFiles: Array.isArray(parsed.targetFiles) ? parsed.targetFiles.map(String) : undefined,
    filesInspected: Array.isArray(parsed.filesInspected) ? parsed.filesInspected.map(String) : undefined,
    riskLevel: validRiskLevels.includes(parsed.riskLevel) ? parsed.riskLevel : undefined,
    executionPlan: Array.isArray(parsed.executionPlan)
      ? parsed.executionPlan
          .filter((s: Record<string, unknown>) => s && typeof s === 'object')
          .map((s: Record<string, any>, i: number) => ({
            step: typeof s.step === 'number' ? s.step : i + 1,
            description: String(s.description || ''),
            targetFiles: Array.isArray(s.targetFiles) ? s.targetFiles.map(String) : [],
            agent: validAgents.includes(s.agent) ? s.agent : 'G1',
            risk: validRiskLevels.includes(s.risk) ? s.risk : 'medium',
          }))
      : undefined,
  }
}

/**
 * Parse verify decision from TL's checkpoint verify output.
 * FIX 2026-09-15 #5 (P3): parse thêm "evidence" — mảng bằng chứng tool THẬT
 * hỗ trợ quyết định (VERIFY EVIDENCE GUARD mirror goal-loop).
 */
function parseVerifyDecision(
  output: string
): { decision: 'CONTINUE' | 'PIVOT' | 'ESCALATE'; reasoning: string; updatedSpec?: string; evidence?: string[] } | null {
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
          evidence: Array.isArray(parsed.evidence)
            ? parsed.evidence.map((e: unknown) => String(e)).filter(Boolean).slice(0, 10)
            : [],
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
 * FIX 2026-09-15 #4 (P3 — audit Team Code) — FABRICATED TOOL-RESULT detector.
 *
 * Audit E2E bắt được thật: agent output KHÔNG kèm tool call nhưng tự viết
 * "[TOOL RESULT] ..." / "[TOOL_RESULT]" / "[KẾT QUẢ TOOL]"... trong văn bản —
 * bằng chứng GIẢ mà các vòng sau + checkpoint verify có thể tin theo (thực tế
 * SENTINEL đã tự ý tạo file trái spec vì tin tool-result bịa của chính mình).
 *
 * Chỉ đọc + regex — không thể throw; trả về marker trùng khớp hoặc null.
 * Lưu ý: được gọi DUY NHẤT tại nhánh "0 tool call parse được" nên văn bản
 * hợp pháp trích dẫn marker khi THẢO LUẬN kết quả cũ (kèm tool call mới) không bị
 * kích oan.
 */
const FABRICATED_TOOL_RESULT_PATTERNS: RegExp[] = [
  /\[\s*TOOL\s*RESULT\s*[:\]]/i,
  /\[\s*TOOL_RESULT\s*[:\]]/i,
  /\[\s*TOOL\s*OUTPUT\s*[:\]]/i,
  /\[\s*KẾT?\s*QUẢ?\s*TOOL\s*[:\]]/i,
  /\[\s*KET\s*QUA\s*TOOL\s*[:\]]/i,
  /\[\s*TOOL\s*CALL\s*RESULT\s*[:\]]/i,
]

function detectFabricatedToolResult(content: string): string | null {
  try {
    if (!content || typeof content !== 'string') return null
    for (const re of FABRICATED_TOOL_RESULT_PATTERNS) {
      const m = content.match(re)
      if (m && m[0]) return m[0]
    }
    return null
  } catch {
    return null
  }
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
      // TASK 43 — loose-repair trước khi bỏ cuộc (mirror tool-calls.ts)
      const args = tryParseLooseJson(jsonStr)
      if (args) {
        calls.push({
          id: `tc_${Date.now()}_${calls.length}`,
          name: toolName,
          args,
        })
      } else {
        console.warn(`[WorkflowEngine] tool call "${toolName}" — args JSON hỏng KỂ CẢ SAU loose-repair (bỏ qua, đếm ở parse-diagnostics nếu có) raw=${jsonStr.slice(0, 100)}`)
      }
    }
  }

  // Pattern 2: Direct tool invocation like opencode({...})
  if (calls.length === 0) {
    const validToolNames = ['opencode', 'knowledge_search', 'knowledge_graph', 'knowledge_write', 'tavily', 'serper', 'jina', 'file_read', 'file_edit', 'file_multi_edit', 'file_write', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'git_push', 'git_pull', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'list_skills', 'read_skill', 'mcp_list_servers', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch', 'lsp_diagnostics', 'browser_screenshot', 'lint', 'type_check', 'test_coverage', 'db_query', 'mcp_call', 'exit_plan_mode', 'cron', 'start_preview', 'stop_preview', 'get_app_runtime_status', 'create_custom_tool', 'delete_custom_tool', 'list_custom_tools', 'manage_tools',
      // FIX 2026-09-15 #7 (P4 — audit Team Code): Pattern 2 thiếu tool mới —
      // agent phát tên_tool({...}) trực tiếp (không có prefix tool_call:) thì
      // KHÔNG được parse → hệ thống không trả kết quả, agent tưởng tool chạy
      // rồi tự bịa output (nguồn hallucination). Bổ sung: git survey + context
      // recall + escalation/delegation/orchestration tools (workflow depth-guard
      // sẽ từ chối delegation lồng bằng thông báo sư phạm — đúng thiết kế).
      'git_status', 'git_diff', 'git_log', 'git_branch', 'context_recall',
      'escalate_problem', 'propose_automation', 'verify_and_push',
      'delegate_task', 'request_code_team', 'dispatch_agent', 'dispatch_agents_parallel',
      'create_agent', 'manage_automation',
      // P5/P8 (2026-11) — run_gate (gate receipt sha256) + work_data (CRUD dữ
      // liệu công việc DB) — mirror tool-calls.ts
      'run_gate', 'work_data']
    const regex2 = new RegExp(`(${validToolNames.join('|')})\\s*\\(\\s*\\{`, 'g')
    let match2
    while ((match2 = regex2.exec(output)) !== null) {
      const toolName = match2[1]
      const braceStart = output.indexOf('{', match2.index + match2[0].length - 1)
      if (braceStart === -1) continue
      const jsonStr = findBalancedJsonUtil(output.slice(braceStart), '')
      if (jsonStr) {
        // TASK 43 — loose-repair trước khi bỏ cuộc (mirror tool-calls.ts)
        const args = tryParseLooseJson(jsonStr)
        if (args) {
          calls.push({
            id: `tc_${Date.now()}_${calls.length}`,
            name: toolName,
            args,
          })
        } else {
          console.warn(`[WorkflowEngine] tool call "${toolName}" (pattern-2) — args JSON hỏng KỂ CẢ SAU loose-repair (bỏ qua) raw=${jsonStr.slice(0, 100)}`)
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
 * Resume a workflow that was paused awaiting user clarification.
 *
 * POST /api/code-team/clarify calls this. It reconstructs the original request
 * from the session's persisted chat history (ChatMessage rows), appends the
 * user's clarification answer as fresh context, and re-runs the pipeline under
 * the SAME sessionId (worklog + CodeTeamSession rows continue in place).
 *
 * Post-deploy audit fix (2026-08-25): this function was referenced by the
 * clarify API route since Phase 1-6 but never implemented — the named export
 * didn't exist, so the route 500'd on import. Now it exists.
 */
export async function resumeWorkflow(
  sessionId: string,
  clarificationResponse: {
    requestId: string
    selectedOption: string
    updatedContext?: string
  },
  emit: SSEEmitter,
  abortSignal?: AbortSignal,
  config?: WorkflowConfig
): Promise<void> {
  // Reconstruct chat history for this session (persisted by the chat API).
  const history = await db.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
    take: 50,
    select: { role: true, content: true },
  })

  const lastUser = [...history].reverse().find(m => m.role === 'user')
  if (!lastUser) {
    throw new Error(
      `Cannot resume workflow "${sessionId}": no prior user message found in chat history`
    )
  }

  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    {
      role: 'user',
      content: `Clarification (request ${clarificationResponse.requestId}): ${clarificationResponse.selectedOption}`,
    },
  ]

  emit({
    type: 'clarification_resolved',
    requestId: clarificationResponse.requestId,
    selectedOption: clarificationResponse.selectedOption,
    updatedContext: clarificationResponse.updatedContext ?? '',
  })

  console.log(
    `[Workflow] Resuming session ${sessionId} after clarification ${clarificationResponse.requestId}: "${clarificationResponse.selectedOption.slice(0, 80)}"`
  )

  await runWorkflow(
    { sessionId, userRequest: lastUser.content, messages },
    emit,
    abortSignal,
    config
  )
}

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
      ctx.skillsRaw = await loadEnabledSkillsRaw()
      ctx.skillsContext = renderSkillsText(ctx.skillsRaw)
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
