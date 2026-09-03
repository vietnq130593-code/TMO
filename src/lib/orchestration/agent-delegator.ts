/**
 * Layer 7.3: Agent Delegation — Sub-agent Dispatch
 *
 * Delegate task phức tạp cho sub-agents chuyên dụng, chạy song song khi có thể.
 *
 * Nguyên tắc:
 *   1. Mỗi sub-agent nhận context đầy đủ
 *   2. Sub-agent tự chủ (autonomous) — không cần hỏi lại main agent
 *   3. Kết quả được integrate cẩn th
ận
 *   4. Main agent verify kết quả sub-agent trước khi accept
 */

import type {
  AgentDelegator,
  DelegatedTask,
  DelegatedTaskResult,
  DelegationDecision,
  DelegationRequest,
  DelegationStrategy,
} from './types'
import type { AgentPosition } from '@/lib/code-team/types'
import { isFlagEnabled } from '@/lib/feature-flags'

// ==================== CONSTANTS ====================

/** Timeout mặc định cho mỗi delegated task (ms) */
const DEFAULT_TASK_TIMEOUT_MS = 120_000 // 2 minutes

/** Số lần retry tối đa cho mỗi task */
const MAX_RETRIES = 2

/** Ngưỡng để delegate (task phức tạp hơn ngưỡng này) */
const DELEGATION_COMPLEXITY_THRESHOLD = 'medium'

// ==================== AGENT DELEGATOR IMPLEMENTATION ====================

/**
 * Create a new Agent Delegator for the given session.
 */
export function createAgentDelegator(
  sessionId: string,
  emit?: (event: Record<string, unknown>) => void
): AgentDelegator {
  // Track active delegations for cancellation
  const activeDelegations = new Map<string, AbortController>()

  return {
    shouldDelegate(request: DelegationRequest): DelegationDecision {
      return shouldDelegateInternal(request)
    },

    async delegate(task: DelegatedTask): Promise<DelegatedTaskResult> {
      return delegateInternal(task, activeDelegations, emit)
    },

    async delegateParallel(tasks: DelegatedTask[]): Promise<DelegatedTaskResult[]> {
      return delegateParallelInternal(tasks, activeDelegations, emit)
    },

    collectResults(results: DelegatedTaskResult[]): string {
      return collectResultsInternal(results)
    },

    cancelDelegation(taskId: string): void {
      const controller = activeDelegations.get(taskId)
      if (controller) {
        controller.abort()
        activeDelegations.delete(taskId)
      }
    },
  }
}

// ==================== INTERNAL FUNCTIONS ====================

/**
 * Determine if a task should be delegated to sub-agents.
 */
function shouldDelegateInternal(request: DelegationRequest): DelegationDecision {
  const {
    complexity,
    canParallelize,
    requiresSpecialization,
    estimatedDuration,
    availableAgents,
  } = request

  // Rule 1: Task đơn giản → không delegate
  if (complexity === 'simple') {
    return {
      shouldDelegate: false,
      strategy: 'none',
      tasks: [],
      reasoning: 'Task đơn giản, tự làm nhanh hơn',
      estimatedTimeSaved: 0,
      risks: [],
    }
  }

  // Rule 2: Có thể parallel → delegate multi-agent
  if (canParallelize && availableAgents.length >= 2) {
    const tasks = buildParallelTasks(request, availableAgents)
    return {
      shouldDelegate: true,
      strategy: 'multi_agent',
      tasks,
      reasoning: `Task có thể parallel với ${availableAgents.length} agents`,
      estimatedTimeSaved: estimatedDuration * 0.4, // ~40% time saved
      risks: ['Coordination overhead', 'Context duplication'],
    }
  }

  // Rule 3: Cần specialized knowledge → delegate single agent
  if (requiresSpecialization && availableAgents.length > 0) {
    const tasks = buildSingleAgentTask(request, availableAgents[0])
    return {
      shouldDelegate: true,
      strategy: 'single_agent',
      tasks,
      reasoning: `Task cần specialized knowledge từ ${availableAgents[0]}`,
      estimatedTimeSaved: estimatedDuration * 0.2,
      risks: ['Context transfer overhead'],
    }
  }

  // Rule 4: Task dài, cần iterative → delegate
  if (estimatedDuration > 60_000) { // > 1 phút
    const fallbackAgent: AgentPosition = availableAgents[0] || 'G2-A'
    const tasks = buildSingleAgentTask(request, fallbackAgent)
    return {
      shouldDelegate: true,
      strategy: 'single_agent',
      tasks,
      reasoning: 'Task dài, cần iterative → delegate cho sub-agent',
      estimatedTimeSaved: estimatedDuration * 0.15,
      risks: ['Communication overhead'],
    }
  }

  // Default: không delegate
  return {
    shouldDelegate: false,
    strategy: 'none',
    tasks: [],
    reasoning: 'Task không đủ điều kiện để delegate',
    estimatedTimeSaved: 0,
    risks: [],
  }
}

/**
 * Delegate a single task to a sub-agent.
 */
async function delegateInternal(
  task: DelegatedTask,
  activeDelegations: Map<string, AbortController>,
  emit?: (event: Record<string, unknown>) => void
): Promise<DelegatedTaskResult> {
  const controller = new AbortController()
  activeDelegations.set(task.id, controller)

  // Emit delegation start event
  if (emit) {
    emit({
      type: 'delegation_start',
      taskId: task.id,
      agentPosition: task.assignedAgent,
      description: task.description,
    })
  }

  const startTime = Date.now()

  try {
    // Simulate sub-agent execution (replace with actual implementation)
    const result = await executeSubAgent(task, controller.signal)

    // Emit delegation complete event
    if (emit) {
      emit({
        type: 'delegation_complete',
        taskId: task.id,
        agentPosition: task.assignedAgent,
        success: result.success,
        duration: Date.now() - startTime,
      })
    }

    return result
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)

    // Emit delegation error
    if (emit) {
      emit({
        type: 'delegation_error',
        taskId: task.id,
        agentPosition: task.assignedAgent,
        error: errorMsg,
      })
    }

    return {
      taskId: task.id,
      agentPosition: task.assignedAgent,
      success: false,
      output: '',
      duration: Date.now() - startTime,
      tokensUsed: 0,
      errors: [{
        id: `err-${Date.now()}`,
        timestamp: new Date(),
        errorType: 'runtime',
        severity: 'high',
        message: errorMsg,
        rootCause: 'Delegation execution failed',
        fixStrategy: 'surgical',
        fixApplied: false,
        fixDescription: '',
        loopDetected: false,
        loopCount: 0,
      }],
      filesCreated: [],
      filesModified: [],
    }
  } finally {
    activeDelegations.delete(task.id)
  }
}

/**
 * Delegate multiple tasks in parallel.
 */
async function delegateParallelInternal(
  tasks: DelegatedTask[],
  activeDelegations: Map<string, AbortController>,
  emit?: (event: Record<string, unknown>) => void
): Promise<DelegatedTaskResult[]> {
  // Run all tasks in parallel with Promise.allSettled
  const promises = tasks.map((task) => delegateInternal(task, activeDelegations, emit))

  const results = await Promise.allSettled(promises)

  // Map results to DelegatedTaskResult
  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value
    }

    // Rejected promise
    const task = tasks[index]
    return {
      taskId: task.id,
      agentPosition: task.assignedAgent,
      success: false,
      output: '',
      duration: 0,
      tokensUsed: 0,
      errors: [{
        id: `err-${Date.now()}`,
        timestamp: new Date(),
        errorType: 'runtime',
        severity: 'critical',
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        rootCause: 'Parallel delegation failed',
        fixStrategy: 'surgical',
        fixApplied: false,
        fixDescription: '',
        loopDetected: false,
        loopCount: 0,
      }],
      filesCreated: [],
      filesModified: [],
    }
  })
}

/**
 * Collect and summarize results from multiple sub-agents.
 */
function collectResultsInternal(results: DelegatedTaskResult[]): string {
  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  const parts: string[] = [
    `## Delegation Results`,
    ``,
    `**Summary:** ${successful.length}/${results.length} tasks completed successfully`,
    ``,
  ]

  if (successful.length > 0) {
    parts.push(`### Successful Tasks`)
    for (const result of successful) {
      parts.push(`- **${result.agentPosition}**: ${result.output.slice(0, 200)}...`)
      if (result.filesCreated.length > 0) {
        parts.push(`  - Files created: ${result.filesCreated.join(', ')}`)
      }
      if (result.filesModified.length > 0) {
        parts.push(`  - Files modified: ${result.filesModified.join(', ')}`)
      }
    }
    parts.push(``)
  }

  if (failed.length > 0) {
    parts.push(`### Failed Tasks`)
    for (const result of failed) {
      parts.push(`- **${result.agentPosition}**: ${result.errors[0]?.message || 'Unknown error'}`)
    }
    parts.push(``)
  }

  // Aggregate files
  const allFilesCreated = results.flatMap((r) => r.filesCreated)
  const allFilesModified = results.flatMap((r) => r.filesModified)

  if (allFilesCreated.length > 0 || allFilesModified.length > 0) {
    parts.push(`### Files Changed`)
    if (allFilesCreated.length > 0) {
      parts.push(`- Created: ${allFilesCreated.join(', ')}`)
    }
    if (allFilesModified.length > 0) {
      parts.push(`- Modified: ${allFilesModified.join(', ')}`)
    }
    parts.push(``)
  }

  return parts.join('\n')
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Build parallel tasks for multi-agent delegation.
 */
function buildParallelTasks(
  request: DelegationRequest,
  availableAgents: AgentPosition[],
  sessionId: string = 'unknown-session'
): DelegatedTask[] {
  // Split the work among available agents
  // In a real implementation, this would analyze the task and split it
  const tasks: DelegatedTask[] = []

  for (let i = 0; i < availableAgents.length; i++) {
    const agent = availableAgents[i]
    tasks.push({
      id: `task-${Date.now()}-${i}`,
      parentSessionId: sessionId,
      assignedAgent: agent,
      taskType: 'parallel_subtask',
      description: `Parallel sub-task ${i + 1}/${availableAgents.length}`,
      input: request.currentContext,
      expectedOutput: 'Completed sub-task result',
      context: request.currentContext,
      timeout: DEFAULT_TASK_TIMEOUT_MS,
      priority: i,
    })
  }

  return tasks
}

/**
 * Build a single agent task.
 */
function buildSingleAgentTask(
  request: DelegationRequest,
  agent: AgentPosition,
  sessionId: string = 'unknown-session'
): DelegatedTask[] {
  return [{
    id: `task-${Date.now()}`,
    parentSessionId: sessionId,
    assignedAgent: agent,
    taskType: 'specialized',
    description: 'Specialized task for single agent',
    input: request.currentContext,
    expectedOutput: 'Completed task result',
    context: request.currentContext,
    timeout: DEFAULT_TASK_TIMEOUT_MS,
    priority: 0,
  }]
}

/**
 * Execute a sub-agent task.
 *
 * v2.1 Phase 5.2 — when ENABLE_REAL_DELEGATE is true, this dispatches a REAL
 * sub-agent LLM call (with optional single tool call + synthesis). When the
 * flag is false, the legacy placeholder behavior (100ms sleep + fake success)
 * is preserved so existing callers/orchestrations/tests don't break.
 *
 * Real path strategy (kept simple per spec — no full ReAct loop):
 *   1. Resolve the agent for task.assignedAgent (DB config or hardcoded defaults)
 *   2. First LLM call — sub-agent produces either a direct response OR a
 *      single tool_call (parsed from text via the `tool_call: name({...})`
 *      convention used throughout the codebase).
 *   3. If a tool_call is detected: execute it via executeTool() and capture
 *      the receipt (success/result + extract any file paths).
 *   4. Final synthesis LLM call (only when step 3 ran) — feed the tool result
 *      back to the sub-agent and ask for a concise final summary.
 *   5. Return DelegatedTaskResult with the sub-agent's actual output + the
 *      files created/modified by the tool call (if any).
 *
 * Dynamic import is used for callLLMForAgent + executeTool + resolveAgent to
 * avoid a static circular dependency between orchestration ↔ code-team modules
 * (code-team/tool-executor in turn imports many things; loading lazily keeps
 * the orchestrator module lightweight when the flag is off).
 */
async function executeSubAgent(
  task: DelegatedTask,
  signal: AbortSignal
): Promise<DelegatedTaskResult> {
  // Check if aborted
  if (signal.aborted) {
    throw new Error('Task was cancelled')
  }

  // Phase 5.2 — flag-off: legacy placeholder (100ms sleep + fake success).
  if (!isFlagEnabled('ENABLE_REAL_DELEGATE')) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return {
      taskId: task.id,
      agentPosition: task.assignedAgent,
      success: true,
      output: `Task completed by ${task.assignedAgent}`,
      duration: 100,
      tokensUsed: 0,
      errors: [],
      filesCreated: [],
      filesModified: [],
    }
  }

  // Phase 5.2 — flag-on: real sub-agent execution path.
  const startTime = Date.now()
  try {
    // Lazy-import to avoid static circular deps + to skip the cost when flag is off.
    const { callLLMForAgent } = await import('@/lib/llm')
    const { executeTool } = await import('@/lib/code-team/tool-executor')
    const { resolveAgent } = await import('@/lib/code-team/agent-resolver')

    // 1. Resolve the sub-agent's config (provider/model/system prompt/tools).
    const agent = await resolveAgent(task.assignedAgent as string)
    if (agent.source === 'missing') {
      throw new Error(`Agent ${task.assignedAgent} not resolvable (source=missing)`)
    }

    // 2. First LLM call — sub-agent produces a response or one tool_call.
    const delegationPrompt = buildDelegationPrompt(task)
    const firstResult = await callLLMForAgent(
      delegationPrompt,
      { provider: agent.provider, model: agent.model },
      agent.instruction || `You are ${agent.name}. Complete the delegated task concisely.`,
      {
        agentId: task.assignedAgent,
        agentName: agent.name,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
      }
    )

    if (!firstResult || (!firstResult.content && !(firstResult.tool_calls?.length))) {
      throw new Error(`LLM call failed for sub-agent ${task.assignedAgent}: ${firstResult?.error || 'no content'}`)
    }

    // 3. Parse tool_call intent from the LLM response.
    //    Native function-calling tool_calls take priority; otherwise regex-parse
    //    the text for the `tool_call: name({...})` convention.
    let toolName: string | null = null
    let toolArgs: Record<string, unknown> = {}

    if (firstResult.tool_calls && firstResult.tool_calls.length > 0) {
      const tc = firstResult.tool_calls[0]
      toolName = tc.function.name
      try {
        toolArgs = JSON.parse(tc.function.arguments)
      } catch {
        // Malformed args — skip the tool call entirely
        console.warn(`[Delegator] Sub-agent ${task.assignedAgent} emitted tool_call ${toolName} but args failed JSON.parse — skipping tool call.`)
        toolName = null
      }
    } else if (firstResult.content) {
      const parsed = parseSingleToolCall(firstResult.content)
      if (parsed) {
        toolName = parsed.name
        toolArgs = parsed.args
      }
    }

    const filesCreated: string[] = []
    const filesModified: string[] = []
    let finalOutput = firstResult.content || ''
    let tokensUsed = firstResult.tokensUsed || 0

    // 4. Execute the tool call (if any) and capture file receipts.
    //    Defense-in-depth (Task 12-AUDIT P2): reject toolName not in the
    //    sub-agent's allowlist. Without this, a prompt-injected LLM could
    //    call a tool the sub-agent isn't entitled to (e.g., a RAMPAGE-only tool
    //    invoked from SHOCWAVE). Mirrors the same guard that workflow-engine's
    //    parseToolCallsFromOutput should have — that's a separate concern;
    //    here we at least lock down the more-autonomous delegate path.
    if (toolName) {
      if (!Array.isArray(agent.tools) || !agent.tools.includes(toolName)) {
        console.warn(`[Delegator] Sub-agent ${task.assignedAgent} attempted out-of-allowlist tool '${toolName}' (allowed: ${(agent.tools || []).join(',') || '<none>'}) — skipping tool call.`)
        finalOutput += `\n\n[Delegator] Refused tool '${toolName}' — not in this sub-agent's allowlist.`
        toolName = null
      }
    }
    if (toolName) {
      console.log(`[Delegator] Sub-agent ${task.assignedAgent} calling tool ${toolName}`)
      const toolResult = await executeTool(toolName, toolArgs)
      tokensUsed += 0 // executeTool doesn't return tokensUsed; we don't have a clean per-tool token metric

      // Best-effort file extraction from the tool receipt
      extractFilePaths(toolResult.result).forEach((p) => {
        if (!filesCreated.includes(p) && !filesModified.includes(p)) {
          filesModified.push(p) // safe default — most agent tools modify rather than create
        }
      })

      // 5. Final synthesis LLM call — feed tool result back to the sub-agent
      //    for a concise final summary. Skip if the tool failed (no useful
      //    observation to synthesize) or if the first response already contained
      //    a clean final answer with no tool intent.
      if (toolResult.success) {
        const synthesisPrompt = buildSynthesisPrompt(task, firstResult.content, toolName, toolResult.result)
        const synthResult = await callLLMForAgent(
          synthesisPrompt,
          { provider: agent.provider, model: agent.model },
          agent.instruction || `You are ${agent.name}. Be concise.`,
          {
            agentId: task.assignedAgent,
            agentName: agent.name,
            temperature: agent.temperature,
            maxTokens: Math.min(agent.maxTokens, 2048),
          }
        )
        if (synthResult?.content) {
          finalOutput = synthResult.content
          tokensUsed += synthResult.tokensUsed || 0
        }
      } else {
        finalOutput += `\n\n[Tool ${toolName} failed — see error in errors array]`
      }
    }

    return {
      taskId: task.id,
      agentPosition: task.assignedAgent,
      success: true,
      output: finalOutput || `Task completed by ${task.assignedAgent}`,
      duration: Date.now() - startTime,
      tokensUsed,
      errors: [],
      filesCreated,
      filesModified,
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[Delegator] Sub-agent ${task.assignedAgent} failed:`, errorMsg)
    return {
      taskId: task.id,
      agentPosition: task.assignedAgent,
      success: false,
      output: '',
      duration: Date.now() - startTime,
      tokensUsed: 0,
      errors: [{
        id: `err-${Date.now()}`,
        timestamp: new Date(),
        errorType: 'runtime',
        severity: 'high',
        message: errorMsg,
        rootCause: 'Sub-agent LLM execution failed',
        fixStrategy: 'surgical',
        fixApplied: false,
        fixDescription: '',
        loopDetected: false,
        loopCount: 0,
      }],
      filesCreated: [],
      filesModified: [],
    }
  }
}

// ==================== v2.1 Phase 5.2 — DELEGATION PROMPT HELPERS ====================

/**
 * Build the delegation prompt for the first LLM call.
 * Combines task.description, task.input, task.context, and task.expectedOutput
 * into a single prompt that asks the sub-agent to either produce a direct
 * response or emit one tool_call to gather information it needs.
 *
 * Kept minimal — the sub-agent's system prompt (from agent resolution) provides
 * the persona and tooling conventions.
 */
function buildDelegationPrompt(task: DelegatedTask): string {
  const parts: string[] = [
    `You are delegated a sub-task by the orchestrator.`,
    ``,
    `**Task ID:** ${task.id}`,
    `**Task type:** ${task.taskType}`,
    `**Description:** ${task.description}`,
    ``,
    `**Input / request:**`,
    task.input || '(none)',
    ``,
  ]
  if (task.context) {
    parts.push(`**Context:**`, task.context, ``)
  }
  if (task.expectedOutput) {
    parts.push(`**Expected output:** ${task.expectedOutput}`, ``)
  }
  parts.push(
    `**Instructions:**`,
    `- Either produce the final answer directly, OR emit exactly ONE tool_call if you need to inspect or modify the workspace.`,
    `- Tool call format (if needed): tool_call: <name>({ ...args })`,
    `- Be concise. Maximum 200 words for the final response.`,
    `- Do NOT emit more than one tool_call. If multiple tools are needed, pick the most informative one.`,
    ``
  )
  return parts.join('\n')
}

/**
 * Build the synthesis prompt for the second LLM call (only when a tool was called).
 * Feeds the original response + tool result back to the sub-agent and asks for
 * a concise final summary.
 */
function buildSynthesisPrompt(
  task: DelegatedTask,
  firstResponse: string,
  toolName: string,
  toolResult: unknown
): string {
  const toolResultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult).slice(0, 4000)
  return [
    `You called tool ${toolName} for task: ${task.description}.`,
    ``,
    `**Your initial response:**`,
    firstResponse.slice(0, 2000),
    ``,
    `**Tool result:**`,
    toolResultStr,
    ``,
    `**Instructions:** Synthesize a concise final answer (max 150 words) that incorporates the tool result. No more tool calls needed.`,
  ].join('\n')
}

/**
 * Parse a single tool_call from the LLM text output.
 * Recognizes the `tool_call: <name>({ ...args })` convention used throughout
 * the codebase (regex-only — does not handle native function-calling tool_calls,
 * which are handled separately by the caller).
 *
 * Returns the first matched tool call, or null if no tool call is found.
 */
function parseSingleToolCall(
  output: string
): { name: string; args: Record<string, unknown> } | null {
  // Pattern: tool_call: name({...})
  const match = output.match(/tool_call:\s*(\w+)\s*\(\s*\{/)
  if (!match) return null

  const toolName = match[1]
  // Find the opening brace and extract balanced JSON
  const braceStart = output.indexOf('{', match.index! + match[0].length - 1)
  if (braceStart === -1) return null

  // Simple balanced JSON extraction (handles one level of nested braces)
  let depth = 0
  let inString = false
  let escape = false
  let endIdx = -1
  for (let i = braceStart; i < output.length; i++) {
    const ch = output[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        endIdx = i
        break
      }
    }
  }
  if (endIdx === -1) return null

  const jsonStr = output.slice(braceStart, endIdx + 1)
  try {
    const args = JSON.parse(jsonStr)
    if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
      return { name: toolName, args }
    }
  } catch {
    // Malformed JSON — no tool call extracted
  }
  return null
}

/**
 * Best-effort extract file paths from a tool receipt.
 * Tool receipts have varying shapes — this looks for common keys like
 * `file`, `filePath`, `path`, `files`, `created`, `modified`, `paths`.
 * Returns a de-duplicated list of absolute or workspace-relative paths.
 */
function extractFilePaths(result: unknown): string[] {
  if (!result || typeof result !== 'object') return []
  const paths: string[] = []
  const r = result as Record<string, unknown>

  const pushIfString = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0 && !paths.includes(v)) {
      paths.push(v)
    }
  }
  const pushIfArray = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const item of v) pushIfString(item)
    }
  }

  // Single-path keys
  for (const key of ['file', 'filePath', 'path', 'newPath', 'oldPath']) {
    pushIfString(r[key])
  }
  // Array-of-paths keys
  for (const key of ['files', 'paths', 'created', 'modified', 'touched', 'filesCreated', 'filesModified']) {
    pushIfArray(r[key])
  }
  // Nested `result` envelope (some tools wrap)
  if (r.result && typeof r.result === 'object') {
    for (const p of extractFilePaths(r.result)) {
      if (!paths.includes(p)) paths.push(p)
    }
  }
  return paths
}
