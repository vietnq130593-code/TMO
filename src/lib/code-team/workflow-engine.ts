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

import { callLLMForAgent, type LLMResult } from '@/lib/llm'
import { db } from '@/lib/db'
import { getAgentTools } from './agents'
import { getAgentPrompt } from './prompts'
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
import { flagMode } from '@/lib/feature-flags'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

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
  const lintResult = await runShellSafe('bun run lint', 60_000)
  const tscResult = await runShellSafe('tsc --noEmit', 60_000)

  const lintErrors = parseLintErrors(lintResult.stderr + lintResult.stdout)
  const tscErrors = parseTscErrors(tscResult.stderr + tscResult.stdout)

  return {
    mode,
    lintErrors: lintErrors.count,
    tscErrors: tscErrors.count,
    lintSample: lintErrors.sample,
    tscSample: tscErrors.sample,
    durationMs: Date.now() - startedAt,
  }
}

async function runShellSafe(command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: process.env.OPENCODE_WORKSPACE || process.cwd(),
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
/** Per-workflow run context — avoids module-level state for concurrent safety */
interface WorkflowContext {
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
      await runPipeline(preComputedRouting, sessionId, userRequest, safeEmit, startTime, isAborted, ctx)
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

      await runPipeline(fallbackDecision, sessionId, userRequest, safeEmit, startTime, isAborted, ctx)
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
    await runPipeline(routingDecision, sessionId, userRequest, safeEmit, startTime, isAborted, ctx)
  } catch (err) {
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
): Promise<void> {
  const pipeline = getPipeline(routingDecision.mode, routingDecision.tier)
  let spec = routingDecision.spec || userRequest // Spec gốc cho toàn bộ pipeline

  // Get TL agent name from resolved cache (BUG 12 fix: don't hardcode 'APEX')
  const tlAgent = ctx.resolvedAgentsCache.get('TL')
  const completedAgents: string[] = tlAgent ? [tlAgent.name] : ['APEX'] // TL already completed in Step 1

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
        // Still complete the session as failed
        const totalDuration = Date.now() - workflowStartTime
        await completeSession(sessionId, 'failed', totalDuration)
        emit({ type: 'workflow_done', totalDuration, sessionId, status: 'escalated' })
        return
      }
      if (verifyResult.decision === 'PIVOT') {
        spec = verifyResult.updatedSpec || spec
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
async function runAgentStep(params: {
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
  const toolCallsLog: Array<{ tool: string; args: Record<string, unknown>; result: string; duration: number; success: boolean }> = []

  console.log(`[Workflow] Running agent: ${agent.name} (${position}) — ${step} [tools: ${tools.join(', ')}]`)

  while (iterations < maxIterations) {
    iterations++

    // Build the prompt from conversation history
    // callLLMForAgent takes a single prompt string, so we format messages into it
    const formattedPrompt = formatMessagesForLLM(messages)

    // Call LLM for this agent — with timeout to prevent infinite hangs
    // Edge case #1: LLM timeout → emit error event, break ReAct loop
    const llmCallPromise = callLLMForAgent(
      formattedPrompt,
      { provider: agent.provider, model: agent.model },
      systemPrompt,
      {
        agentId: position,
        agentName: agent.name,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
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

    // Check if LLM output contains tool calls
    // Since callLLMForAgent doesn't natively support function calling response,
    // we parse tool calls from the output text using the format agents are instructed to use
    const toolCalls = parseToolCallsFromOutput(result.content)

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

  // Log summary
  console.log(`[Workflow] ${agent.name} done: ${iterations} iterations, ${totalToolCalls} tool calls, ${Date.now() - stepStartTime}ms`)

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
    const validToolNames = ['opencode', 'knowledge_search', 'knowledge_graph', 'knowledge_write', 'tavily', 'serper', 'jina', 'file_edit', 'file_delete', 'file_list', 'grep', 'run_tests', 'git_commit', 'get_diagnostics', 'decompose_task', 'create_task', 'update_task', 'get_plan', 'summarize', 'synthesize', 'run_bg', 'read_output', 'kill_process', 'manage_packages', 'gateway_tool', 'shell', 'todo_write', 'todo_read', 'web_search', 'web_fetch', 'gateway_exec', 'gateway_read', 'gateway_write', 'gateway_edit', 'gateway_apply_patch']
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
