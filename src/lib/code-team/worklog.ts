/**
 * Code Team — Worklog System
 *
 * Implements the READ-WRITE-VERIFY LOOP from workflow doc:
 *   WRITE — Mỗi G sau khi xong việc → GHI worklog + Code Location Map
 *   READ  — TL đọc lại worklog sau mỗi Group (Checkpoint)
 *   VERIFY — TL so sánh worklog với spec → CONTINUE / PIVOT / ESCALATE
 *   UPDATE — TL cập nhật spec → Giao Group tiếp hoặc điều chỉnh
 *
 * Also implements DIRECTED READING + CODE LOCATION MAP:
 *   LỚP 1: SPEC (Từ TL) — "Yêu cầu gốc là gì?" — North Star
 *   LỚP 2: WORKLOG (Từ G trước) — "G trước đã làm gì?" — Context + Bản đồ
 *   LỚP 3: CODE THẬT (Từ file system) — "Code thực sự viết như thế nào?" — Ground Truth
 */

import { db } from '@/lib/db'
import { getAgentTools } from './agents'
// FIX 2026-08-29: findBalancedJson được tách sang module pure-utility riêng để
// tool-calls.ts (chat route) không phải kéo theo Prisma DB + agents registry.
// Re-export giữ backward-compat cho workflow-engine.ts và các importer cũ.
import { findBalancedJson } from './find-balanced-json'
export { findBalancedJson }

// ==================== TYPES ====================

/** Core worklog entry — written by each agent after completing its step */
export interface WorklogEntry {
  sessionId: string
  agentName: string
  position: string
  step: string
  timestamp: Date
  summary: string
  completed: string[]
  inProgress: string[]
  issues: WorklogIssue[]
  suggestions: string[]
  concerns: string[]
  codeLocationMap: CodeLocationMap
  nextSteps: string[]
  outputForNext: string
  routingDecision?: RoutingDecision
  unfixedBugs?: UnfixedBug[]
  kbWrites?: KBWrite[]
  toolCallsLog?: ToolCallLog[]
}

export interface WorklogIssue {
  severity: 'critical' | 'high' | 'medium' | 'low'
  type: 'security' | 'logic' | 'type' | 'edge_case' | 'compatibility' | 'performance' | 'simplification' | 'architecture' | 'best_practice' | 'scalability'
  description: string
  location?: string
  fixApplied?: boolean
  fixDescription?: string
}

export interface CodeLocationMap {
  filesToRead: Array<{
    path: string
    priority: 'critical' | 'high' | 'medium' | 'low'
    reason: string
    lines?: string
  }>
  filesToSkip: Array<{ path: string; reason: string }>
  dependencies: Array<{ from: string; to: string; type: 'import' | 'extends' | 'calls' | 'uses' }>
  readingStrategy: 'bug_locations' | 'dependency_chain' | 'full'
}

export interface RoutingDecision {
  mode: 'A' | 'B' | 'C'
  tier: 1 | 2 | 3
  score: number
  reasoning: string
  parts: PartDefinition[]
  spec?: string /// Detailed spec for each part (from TL routing analysis)
  /// Files the TL identified as needing modification (populated after recon phase)
  targetFiles?: string[]
  /// Files the TL inspected during recon (for audit / context tracking)
  filesInspected?: string[]
  /// Risk level assessed by TL after reading the code
  riskLevel?: 'low' | 'medium' | 'high'
  /// Structured execution plan with ordered steps (populated after recon)
  executionPlan?: ExecutionPlanStep[]
}

/// A single step in the TL's execution plan — produced after recon (file reading)
export interface ExecutionPlanStep {
  step: number
  description: string
  targetFiles: string[]
  agent: 'TL' | 'G1' | 'G2-A' | 'G2-B' | 'G3'
  risk: 'low' | 'medium' | 'high'
}

export interface PartDefinition {
  name: string
  type: 'visual' | 'backend'
  description: string
  dependency: string[]
}

export interface UnfixedBug {
  severity: 'critical' | 'high' | 'medium' | 'low'
  description: string
  reason: string
}

export interface KBWrite {
  category: string
  content: string
  reason: string
}

export interface ToolCallLog {
  tool: string
  args: Record<string, unknown>
  result: string
  duration: number
  success: boolean
}

// ==================== WORKLOG WRITE ====================

/**
 * WRITE — Ghi worklog sau mỗi agent hoàn thành.
 * Workflow doc: "WRITE — Mỗi G sau khi xong việc → GHI worklog"
 */
/** Optional duration override — caller can pass actual agent work duration in ms */
export async function writeWorklog(entry: WorklogEntry, agentWorkDurationMs?: number): Promise<void> {
  await db.codeTeamWorklog.create({
    data: {
      sessionId: entry.sessionId,
      agentName: entry.agentName,
      position: entry.position,
      step: entry.step,
      summary: entry.summary,
      content: JSON.stringify(entry),
      toolCalls: JSON.stringify(entry.toolCallsLog || []),
      duration: agentWorkDurationMs ?? 0,
    },
  })

  console.log(`[Worklog] Written: ${entry.agentName} (${entry.position}) — ${entry.step}${agentWorkDurationMs ? ` (${agentWorkDurationMs}ms)` : ''}`)
}

// ==================== WORKLOG READ ====================

/**
 * READ — Đọc worklog của session.
 * Workflow doc: "READ — TL đọc lại worklog sau mỗi Group"
 */
export async function readWorklog(sessionId: string, position?: string): Promise<WorklogEntry[]> {
  const where: { sessionId: string; position?: string } = { sessionId }
  if (position) where.position = position

  const records = await db.codeTeamWorklog.findMany({
    where,
    orderBy: { createdAt: 'asc' },
  })

  return records.map(r => {
    try {
      return JSON.parse(r.content) as WorklogEntry
    } catch {
      // Fallback: construct from DB fields if JSON parse fails
      return {
        sessionId: r.sessionId,
        agentName: r.agentName,
        position: r.position,
        step: r.step,
        timestamp: r.createdAt,
        summary: r.summary,
        completed: [],
        inProgress: [],
        issues: [],
        suggestions: [],
        concerns: [],
        codeLocationMap: { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
        nextSteps: [],
        outputForNext: '',
      } satisfies WorklogEntry
    }
  })
}

/**
 * READ LATEST — Đọc worklog mới nhất của 1 agent trong session.
 * Used by TL to check the most recent output from a specific agent.
 */
export async function readLatestWorklog(sessionId: string, agentName: string): Promise<WorklogEntry | null> {
  const record = await db.codeTeamWorklog.findFirst({
    where: { sessionId, agentName },
    orderBy: { createdAt: 'desc' },
  })

  if (!record) return null

  try {
    return JSON.parse(record.content) as WorklogEntry
  } catch {
    return {
      sessionId: record.sessionId,
      agentName: record.agentName,
      position: record.position,
      step: record.step,
      timestamp: record.createdAt,
      summary: record.summary,
      completed: [],
      inProgress: [],
      issues: [],
      suggestions: [],
      concerns: [],
      codeLocationMap: { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
      nextSteps: [],
      outputForNext: '',
    } satisfies WorklogEntry
  }
}

/**
 * READ ALL FOR AGENT — Đọc tất cả worklog entries của 1 agent.
 * Used for tracking iteration loops (e.g., G2-B 3 vòng iteration).
 */
export async function readWorklogByAgent(sessionId: string, agentName: string): Promise<WorklogEntry[]> {
  const records = await db.codeTeamWorklog.findMany({
    where: { sessionId, agentName },
    orderBy: { createdAt: 'asc' },
  })

  return records.map(r => {
    try {
      return JSON.parse(r.content) as WorklogEntry
    } catch {
      return {
        sessionId: r.sessionId,
        agentName: r.agentName,
        position: r.position,
        step: r.step,
        timestamp: r.createdAt,
        summary: r.summary,
        completed: [],
        inProgress: [],
        issues: [],
        suggestions: [],
        concerns: [],
        codeLocationMap: { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
        nextSteps: [],
        outputForNext: '',
      } satisfies WorklogEntry
    }
  })
}

// ==================== WORKLOG VERIFY ====================

/**
 * VERIFY — TL so sánh worklog với spec.
 * Workflow doc: "VERIFY — TL so sánh worklog với spec → CONTINUE / PIVOT / ESCALATE"
 *
 * @returns 'CONTINUE' | 'PIVOT' | 'ESCALATE'
 */
export function verifyWorklog(worklog: WorklogEntry, originalSpec: string): 'CONTINUE' | 'PIVOT' | 'ESCALATE' {
  const criticalIssues = worklog.issues.filter(i => i.severity === 'critical' && !i.fixApplied)
  const highIssues = worklog.issues.filter(i => i.severity === 'high' && !i.fixApplied)

  // ESCALATE: Critical unfixed issues → need user input
  if (criticalIssues.length > 0) return 'ESCALATE'

  // PIVOT: Too many high unfixed issues → direction change needed
  if (highIssues.length > 2) return 'PIVOT'

  // CHECK SPEC COVERAGE: If worklog completed nothing and spec has requirements → PIVOT
  // Workflow doc: "VERIFY — TL so sánh worklog với spec → CONTINUE / PIVOT / ESCALATE"
  // Only PIVOT if the agent also has no summary — empty summary + empty completed = likely parse failure,
  // not a genuine "agent did nothing" scenario
  if (originalSpec && worklog.completed.length === 0 && worklog.issues.length === 0 && !worklog.summary.trim()) {
    // Agent reported no completions, no issues, AND no summary — likely didn't understand the spec
    return 'PIVOT'
  }

  // CONTINUE: Progress on track
  return 'CONTINUE'
}

/**
 * VERIFY CHECKPOINT — Full checkpoint verification for TL.
 * Checks all worklogs from the last completed group.
 *
 * @returns checkpoint decision with reasoning
 */
export function verifyCheckpoint(
  worklogs: WorklogEntry[],
  originalSpec: string
): { decision: 'CONTINUE' | 'PIVOT' | 'ESCALATE'; reasoning: string; issues: string[] } {
  const allIssues = worklogs.flatMap(wl => wl.issues)
  const criticalUnfixed = allIssues.filter(i => i.severity === 'critical' && !i.fixApplied)
  const highUnfixed = allIssues.filter(i => i.severity === 'high' && !i.fixApplied)
  const issues: string[] = []

  if (criticalUnfixed.length > 0) {
    issues.push(...criticalUnfixed.map(i => `[CRITICAL] ${i.type}: ${i.description}`))
    return {
      decision: 'ESCALATE',
      reasoning: `Phát hiện ${criticalUnfixed.length} critical issues chưa fix. Cần user input.`,
      issues,
    }
  }

  if (highUnfixed.length > 2) {
    issues.push(...highUnfixed.map(i => `[HIGH] ${i.type}: ${i.description}`))
    return {
      decision: 'PIVOT',
      reasoning: `Phát hiện ${highUnfixed.length} high issues chưa fix. Cần thay đổi approach.`,
      issues,
    }
  }

  if (highUnfixed.length > 0) {
    issues.push(...highUnfixed.map(i => `[HIGH] ${i.type}: ${i.description}`))
  }

  return {
    decision: 'CONTINUE',
    reasoning: `Progress đúng kế hoạch. ${highUnfixed.length} high issues chưa fix nhưng chấp nhận được.`,
    issues,
  }
}

// ==================== BUILD CONTEXT ====================

/**
 * BUILD CONTEXT cho agent tiếp theo.
 * Workflow doc: "3 Lớp thông tin G2-B/G3 cần":
 *   LỚP 1: SPEC (Từ TL) — "Yêu cầu gốc là gì?" — North Star
 *   LỚP 2: WORKLOG (Từ G trước) — "G trước đã làm gì?" — Context + Bản đồ
 *   LỚP 3: CODE THẬT (Từ file system) — Agent sẽ đọc qua opencode tool
 */
export async function buildContextForAgent(
  sessionId: string,
  targetPosition: string,
  spec: string,
): Promise<string> {
  const allWorklogs = await readWorklog(sessionId)
  const targetTools = getAgentTools(targetPosition)

  // Truncate spec to prevent context overflow (max 2000 chars)
  const maxSpecLen = 2000
  const truncatedSpec = spec.length > maxSpecLen
    ? spec.slice(0, maxSpecLen) + '\n\n... [SPEC TRUNCATED — original was too long]'
    : spec

  let context = `━━━ LỚP 1: SPEC GỐC TỪ TL ━━━\n${truncatedSpec}\n\n`
  context += `━━━ LỚP 2: WORKLOG TỪ CÁC AGENTS TRƯỚC ━━━\n`
  context += `Bạn có quyền sử dụng tools: ${targetTools.join(', ')}\n\n`

  // Truncate each worklog output to prevent context overflow (max 800 chars per outputForNext)
  const maxOutputLen = 800

  for (const wl of allWorklogs) {
    context += `\n--- ${wl.agentName} (${wl.position}) — ${wl.step} ---\n`
    context += `Summary: ${wl.summary}\n`

    if (wl.completed.length > 0) {
      context += `Completed: ${wl.completed.join(', ')}\n`
    }

    if (wl.issues.length > 0) {
      context += `Issues: ${wl.issues.map(i =>
        `[${i.severity}] ${i.type}: ${i.description}${i.fixApplied ? ' (FIXED)' : ''}${i.location ? ` @ ${i.location}` : ''}`
      ).join(';\n  ')}\n`
    }

    if (wl.suggestions.length > 0) {
      context += `Suggestions: ${wl.suggestions.join('; ')}\n`
    }

    if (wl.concerns.length > 0) {
      context += `Concerns: ${wl.concerns.join('; ')}\n`
    }

    if (wl.outputForNext) {
      const output = wl.outputForNext.length > maxOutputLen
        ? wl.outputForNext.slice(0, maxOutputLen) + '\n... [TRUNCATED]'
        : wl.outputForNext
      context += `Output cho agent tiếp: ${output}\n`
    }

    // Unfixed bugs from G2-B
    if (wl.unfixedBugs && wl.unfixedBugs.length > 0) {
      context += `Unfixed bugs (cho G3): ${wl.unfixedBugs.map(b =>
        `[${b.severity}] ${b.description} (${b.reason})`
      ).join('; ')}\n`
    }

    // Code Location Map — hướng dẫn đọc code
    if (wl.codeLocationMap) {
      context += `\nCode Location Map (đọc TRƯỚC khi đọc code):\n`
      context += `Reading Strategy: ${wl.codeLocationMap.readingStrategy}\n`

      if (wl.codeLocationMap.filesToRead.length > 0) {
        context += `Files to READ:\n`
        for (const f of wl.codeLocationMap.filesToRead) {
          context += `  [${f.priority}] ${f.path}${f.lines ? ` (lines: ${f.lines})` : ''} — ${f.reason}\n`
        }
      }

      if (wl.codeLocationMap.filesToSkip.length > 0) {
        context += `Files to SKIP:\n`
        for (const f of wl.codeLocationMap.filesToSkip) {
          context += `  ${f.path} — ${f.reason}\n`
        }
      }

      if (wl.codeLocationMap.dependencies.length > 0) {
        context += `Dependencies:\n`
        for (const d of wl.codeLocationMap.dependencies) {
          context += `  ${d.from} → ${d.to} (${d.type})\n`
        }
      }
    }

    // KB writes from G3
    if (wl.kbWrites && wl.kbWrites.length > 0) {
      context += `\nKB Writes:\n`
      for (const kb of wl.kbWrites) {
        context += `  [${kb.category}] ${kb.content} (${kb.reason})\n`
      }
    }

    // Routing decision from TL
    if (wl.routingDecision) {
      context += `\nRouting Decision: Mode ${wl.routingDecision.mode}, Tier ${wl.routingDecision.tier}, Score ${wl.routingDecision.score}\n`
      context += `Reasoning: ${wl.routingDecision.reasoning}\n`
      if (wl.routingDecision.parts.length > 0) {
        context += `Parts: ${wl.routingDecision.parts.map(p =>
          `${p.name} (${p.type})${p.dependency.length > 0 ? ` → depends on: ${p.dependency.join(', ')}` : ''}`
        ).join('; ')}\n`
      }
    }
  }

  context += `\n━━━ LỚP 3: CODE THẬT ━━━\n`
  context += `Sử dụng opencode tool để đọc code thực từ file system.\n`
  context += `Ưu tiên đọc files theo Code Location Map ở trên.\n`

  return context
}

// ==================== SESSION HELPERS ====================

/**
 * Create or update Code Team session.
 * Tracks overall workflow state.
 */
export async function upsertSession(data: {
  sessionId: string
  routingMode?: string
  tier?: number
  score?: number
  currentStep?: string
  currentAgent?: string | null  // null = clear the field, undefined = keep existing
  completedAgents?: string[]
  partsDefinition?: PartDefinition[]
}): Promise<void> {
  const existing = await db.codeTeamSession.findUnique({
    where: { sessionId: data.sessionId },
  })

  if (existing) {
    await db.codeTeamSession.update({
      where: { sessionId: data.sessionId },
      data: {
        // Allow updating routing/tier/score when TL pivots
        routingMode: data.routingMode ?? existing.routingMode,
        tier: data.tier ?? existing.tier,
        score: data.score ?? existing.score,
        currentStep: data.currentStep ?? existing.currentStep,
        // currentAgent: null clears the field, undefined keeps existing
        currentAgent: data.currentAgent === null ? null : (data.currentAgent ?? existing.currentAgent),
        completedAgents: data.completedAgents
          ? JSON.stringify(data.completedAgents)
          : existing.completedAgents,
        partsDefinition: data.partsDefinition
          ? JSON.stringify(data.partsDefinition)
          : existing.partsDefinition,
      },
    })
  } else {
    // Create requires routingMode, tier, score
    if (!data.routingMode || data.tier === undefined || data.score === undefined) {
      throw new Error('upsertSession: routingMode, tier, and score are required when creating a new session')
    }
    await db.codeTeamSession.create({
      data: {
        sessionId: data.sessionId,
        routingMode: data.routingMode,
        tier: data.tier,
        score: data.score,
        currentStep: data.currentStep || 'pending',
        currentAgent: data.currentAgent,
        completedAgents: JSON.stringify(data.completedAgents || []),
        partsDefinition: JSON.stringify(data.partsDefinition || []),
      },
    })
  }
}

/**
 * Mark session as completed or failed.
 * Also clears currentAgent and optionally updates completedAgents.
 *
 * 'completed_with_errors' (strict quality-gate outcome from runWorkflow) is
 * accepted since the DB column is a free-form string and the status API
 * surfaces it verbatim — callers get an honest terminal state instead of a
 * type error forcing a silent downgrade to 'completed'.
 */
export async function completeSession(
  sessionId: string,
  status: 'completed' | 'completed_with_errors' | 'failed',
  totalDuration?: number,
  completedAgents?: string[],
): Promise<void> {
  const updateData: Record<string, unknown> = {
    currentStep: status,
    totalDuration: totalDuration ?? 0,
    currentAgent: null, // Clear current agent when session ends
  }
  if (completedAgents) {
    updateData.completedAgents = JSON.stringify(completedAgents)
  }

  await db.codeTeamSession.update({
    where: { sessionId },
    data: updateData,
  })
}

/**
 * Get session state.
 */
export async function getSession(sessionId: string) {
  const session = await db.codeTeamSession.findUnique({
    where: { sessionId },
  })

  if (!session) return null

  return {
    ...session,
    completedAgents: JSON.parse(session.completedAgents) as string[],
    partsDefinition: JSON.parse(session.partsDefinition) as PartDefinition[],
  }
}

// ==================== PARSE WORKLOG FROM LLM OUTPUT ====================

/**
 * Parse worklog from LLM output — extract JSON from text.
 * LLM outputs JSON blocks inside ```json ... ``` markers.
 * We also try to extract structured data from free-text output.
 */
export function parseWorklogFromOutput(output: string): Partial<WorklogEntry> | null {
  // Strategy 1: Find JSON block in output
  const jsonMatch = output.match(/```json\s*([\s\S]*?)```/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      // Validate required fields
      if (parsed.summary || parsed.completed || parsed.issues) {
        return normalizeWorklogEntry(parsed)
      }
    } catch {
      // JSON parse failed, try next strategy
    }
  }

  // Strategy 2: Try to find raw JSON object in output (without markdown wrapper)
  // Use balanced-brace matching to avoid greedy over-match across multiple objects
  const rawJsonMatch = findBalancedJson(output, '"summary"')
  if (rawJsonMatch) {
    try {
      const parsed = JSON.parse(rawJsonMatch)
      if (parsed.summary) {
        return normalizeWorklogEntry(parsed)
      }
    } catch {
      // JSON parse failed
    }
  }

  // Strategy 3: Extract from free text (fallback — minimal worklog)
  return extractWorklogFromText(output)
}

/**
 * Normalize a parsed worklog entry — ensure all required fields exist.
 */
function normalizeWorklogEntry(parsed: Record<string, unknown>): Partial<WorklogEntry> {
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    completed: Array.isArray(parsed.completed)
      ? parsed.completed.map(String)
      : [],
    inProgress: Array.isArray(parsed.inProgress)
      ? parsed.inProgress.map(String)
      : [],
    issues: Array.isArray(parsed.issues)
      ? parsed.issues.map(normalizeIssue)
      : [],
    suggestions: Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map(String)
      : [],
    concerns: Array.isArray(parsed.concerns)
      ? parsed.concerns.map(String)
      : [],
    codeLocationMap: normalizeCodeLocationMap(parsed.codeLocationMap as Record<string, unknown> | undefined),
    nextSteps: Array.isArray(parsed.nextSteps)
      ? parsed.nextSteps.map(String)
      : [],
    outputForNext: typeof parsed.outputForNext === 'string' ? parsed.outputForNext : '',
    routingDecision: parsed.routingDecision as RoutingDecision | undefined,
    unfixedBugs: Array.isArray(parsed.unfixedBugs)
      ? parsed.unfixedBugs.map(normalizeUnfixedBug)
      : undefined,
    kbWrites: Array.isArray(parsed.kbWrites)
      ? parsed.kbWrites.map((k: Record<string, unknown>) => ({
          category: (k.category as string) || '',
          content: (k.content as string) || '',
          reason: (k.reason as string) || '',
        }))
      : undefined,
    // Arch spec from G1 — stored in outputForNext if needed
  }
}

/**
 * Normalize CodeLocationMap — ensure all required fields exist.
 */
function normalizeCodeLocationMap(
  raw: Record<string, unknown> | undefined
): CodeLocationMap {
  if (!raw) {
    return { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' }
  }

  const validStrategies = ['bug_locations', 'dependency_chain', 'full'] as const
  const strategy = validStrategies.includes(raw.readingStrategy as typeof validStrategies[number])
    ? (raw.readingStrategy as CodeLocationMap['readingStrategy'])
    : 'full'

  return {
    filesToRead: Array.isArray(raw.filesToRead)
      ? raw.filesToRead.map((f: Record<string, unknown>) => ({
          path: (f.path as string) || '',
          priority: (['critical', 'high', 'medium', 'low'].includes(f.priority as string)
            ? f.priority : 'medium') as CodeLocationMap['filesToRead'][number]['priority'],
          reason: (f.reason as string) || '',
          lines: (f.lines as string) || undefined,
        }))
      : [],
    filesToSkip: Array.isArray(raw.filesToSkip)
      ? raw.filesToSkip.map((f: Record<string, unknown>) => ({
          path: (f.path as string) || '',
          reason: (f.reason as string) || '',
        }))
      : [],
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.map((d: Record<string, unknown>) => ({
          from: (d.from as string) || '',
          to: (d.to as string) || '',
          type: (['import', 'extends', 'calls', 'uses'].includes(d.type as string)
            ? d.type : 'uses') as CodeLocationMap['dependencies'][number]['type'],
        }))
      : [],
    readingStrategy: strategy,
  }
}

/**
 * findBalancedJson đã chuyển sang ./find-balanced-json.ts (2026-08-29)
 * — xem re-export ở đầu file để biết backward-compat.
 */

/**
 * Normalize a single WorklogIssue — validate and default fields.
 */
function normalizeIssue(raw: Record<string, unknown>): WorklogIssue {
  const validSeverities = ['critical', 'high', 'medium', 'low'] as const
  const validTypes = ['security', 'logic', 'type', 'edge_case', 'compatibility', 'performance', 'simplification', 'architecture', 'best_practice', 'scalability'] as const

  return {
    severity: validSeverities.includes(raw.severity as typeof validSeverities[number])
      ? (raw.severity as WorklogIssue['severity'])
      : 'medium',
    type: validTypes.includes(raw.type as typeof validTypes[number])
      ? (raw.type as WorklogIssue['type'])
      : 'logic',
    description: typeof raw.description === 'string' ? raw.description : String(raw.description ?? ''),
    location: typeof raw.location === 'string' ? raw.location : undefined,
    fixApplied: typeof raw.fixApplied === 'boolean' ? raw.fixApplied : false,
    fixDescription: typeof raw.fixDescription === 'string' ? raw.fixDescription : undefined,
  }
}

/**
 * Normalize a single UnfixedBug — validate and default fields.
 */
function normalizeUnfixedBug(raw: Record<string, unknown>): UnfixedBug {
  const validSeverities = ['critical', 'high', 'medium', 'low'] as const

  return {
    severity: validSeverities.includes(raw.severity as typeof validSeverities[number])
      ? (raw.severity as UnfixedBug['severity'])
      : 'low',
    description: typeof raw.description === 'string' ? raw.description : String(raw.description ?? ''),
    reason: typeof raw.reason === 'string' ? raw.reason : 'Not specified',
  }
}

function extractWorklogFromText(output: string): Partial<WorklogEntry> | null {
  const lines = output.split('\n').filter(l => l.trim())
  if (lines.length === 0) return null

  // Use first meaningful line as summary
  const summary = lines.slice(0, 3).join(' ').slice(0, 500)

  // Look for issue indicators
  const issues: WorklogIssue[] = []
  const issuePatterns = [
    { pattern: /bug[:\s]+(.+)/i, type: 'logic' as const, severity: 'high' as const },
    { pattern: /security[:\s]+(.+)/i, type: 'security' as const, severity: 'critical' as const },
    { pattern: /error[:\s]+(.+)/i, type: 'logic' as const, severity: 'high' as const },
    { pattern: /warning[:\s]+(.+)/i, type: 'type' as const, severity: 'medium' as const },
    { pattern: /fix(?:ed)?[:\s]+(.+)/i, type: 'logic' as const, severity: 'medium' as const },
  ]

  for (const line of lines) {
    for (const { pattern, type, severity } of issuePatterns) {
      const match = line.match(pattern)
      if (match) {
        issues.push({
          severity,
          type,
          description: match[1].slice(0, 200),
          fixApplied: line.toLowerCase().includes('fixed') || line.toLowerCase().includes('đã fix'),
        })
      }
    }
  }

  return {
    summary,
    completed: [],
    inProgress: [],
    issues,
    suggestions: [],
    concerns: [],
    codeLocationMap: { filesToRead: [], filesToSkip: [], dependencies: [], readingStrategy: 'full' },
    nextSteps: [],
    outputForNext: output.slice(0, 2000),
  }
}

// ==================== UTILITY ====================

/**
 * Get worklog statistics for a session.
 * Useful for TL verify and for monitoring.
 */
export async function getWorklogStats(sessionId: string): Promise<{
  totalEntries: number
  totalIssues: number
  criticalIssues: number
  highIssues: number
  fixedIssues: number
  agentsCompleted: string[]
  lastUpdate: Date | null
}> {
  const worklogs = await readWorklog(sessionId)

  const allIssues = worklogs.flatMap(wl => wl.issues)
  const agentsCompleted = [...new Set(worklogs.map(wl => wl.agentName))]

  return {
    totalEntries: worklogs.length,
    totalIssues: allIssues.length,
    criticalIssues: allIssues.filter(i => i.severity === 'critical').length,
    highIssues: allIssues.filter(i => i.severity === 'high').length,
    fixedIssues: allIssues.filter(i => i.fixApplied).length,
    agentsCompleted,
    lastUpdate: worklogs.length > 0 ? worklogs[worklogs.length - 1].timestamp : null,
  }
}
