/**
 * Code Team — Smart TL Bridge (C2: "Triển khai" Keyword Trigger Resolution)
 *
 * Giải quyết C2 từ docs/critical-issues-resolution.md:
 *
 * Vấn đề: Code Team workflow chỉ kích hoạt khi user gõ keyword "tiến hành triển khai".
 *   - Không discoverable — user mới không biết phải gõ gì
 *   - TL passive — không được cơ hội đánh giá request trước khi trigger
 *   - Workflow doc nói "TL tự quyết" nhưng thực tế TL chỉ được hỏi SAU khi user trigger
 *
 * Giải pháp: Smart TL Bridge — TL tự đánh giá request và đề xuất workflow.
 *   - assessRequest() → SIMPLE | CODE_TEAM
 *   - SIMPLE → TL trả lời trực tiếp (chat bình thường)
 *   - CODE_TEAM → TL trả kèm routing suggestion + suggestion text cho user
 *
 * Điểm mấu chốt:
 *   - TL chủ động đánh giá request TRƯỚC khi workflow chạy
 *   - User được hỏi trước khi workflow trigger (Suggestion Card ở Phase 3)
 *   - Backward compatible: keyword "tiến hành triển khai" vẫn trigger trực tiếp
 *   - Assessment nhanh: single LLM call, ~2-3s
 *   - Timeout protection: max 5s → fallback SIMPLE
 */

import { callLLMForAgent } from '@/lib/llm'
import { resolveAgent } from './agent-resolver'
import type { RoutingDecision } from './worklog'

// ==================== TYPES ====================

/** TL Assessment result — decides if request needs Code Team workflow */
export interface TLAssessment {
  /** Decision: SIMPLE (chat bình thường) or CODE_TEAM (cần workflow) */
  decision: 'SIMPLE' | 'CODE_TEAM'
  /** Reasoning for the decision */
  reasoning: string
  /** Routing suggestion (only when CODE_TEAM) */
  routing?: {
    mode: 'A' | 'B' | 'C'
    tier: 1 | 2 | 3
    score: number
    reasoning: string
  }
  /** Short suggestion text for user (only when CODE_TEAM) */
  suggestion?: string
  /** Direct answer from TL (only when SIMPLE) */
  directAnswer?: string
}

/** Assessment cache — prevents redundant LLM calls for same message */
interface CachedAssessment {
  assessment: TLAssessment
  timestamp: number
}

// ==================== ASSESSMENT CACHE ====================

const assessmentCache = new Map<string, CachedAssessment>()
const CACHE_TTL_MS = 60_000 // 1 minute TTL
const MAX_CACHE_SIZE = 50
const MAX_USER_MESSAGE_LENGTH = 2000 // Truncate long messages to avoid context overflow

function getCacheKey(message: string): string {
  // Simple hash of the message for cache key
  let hash = 0
  for (let i = 0; i < message.length; i++) {
    const char = message.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0 // Convert to 32-bit integer
  }
  return `assess:${hash}:${message.slice(0, 50)}`
}

function getCachedAssessment(message: string): TLAssessment | null {
  const key = getCacheKey(message)
  const cached = assessmentCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) {
    assessmentCache.delete(key)
    return null
  }
  return cached.assessment
}

function setCachedAssessment(message: string, assessment: TLAssessment): void {
  // Evict oldest entries if cache is full
  if (assessmentCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = assessmentCache.keys().next().value
    if (oldestKey) assessmentCache.delete(oldestKey)
  }
  const key = getCacheKey(message)
  assessmentCache.set(key, { assessment, timestamp: Date.now() })
}

// ==================== TL ASSESSMENT PROMPT ====================

const TL_ASSESSMENT_PROMPT = `Bạn là MEGATRON — Team Lead của Code Team.

Nhiệm vụ: Đánh giá xem request của user có cần Code Team workflow hay không.

QUYẾT ĐỊNH:
- SIMPLE: User hỏi thông tin, chat bình thường, hỏi kiến thức chung, yêu cầu giải thích → Trả lời trực tiếp
- CODE_TEAM: User yêu cầu code, tạo tính năng, sửa bug phức tạp, xây dựng hệ thống, triển khai, implement → Cần Code Team

ĐÁNH GIÁ ROUTING (chỉ khi CODE_TEAM):
Phân tích request → Scoring (3 tiêu chí × 1-3 điểm):
- Phạm vi: 1(1 file <50 dòng) | 2(2-5 files) | 3(>5 files, multi-module)
- Suy luận: 1(Fix bug rõ ràng) | 2(Feature mới) | 3(Kiến trúc mới)
- Rủi ro: 1(Không ảnh hưởng) | 2(Ảnh hưởng module liên quan) | 3(Ảnh hưởng toàn hệ thống)

Tổng score → Tier: 3-4=Simple(Tier1) | 5-7=Medium(Tier2) | 8-9=Complex(Tier3)
Loại request → Mode: A(Pure Visual — chỉ UI/UX) | B(Pure Backend — chỉ logic/API/DB) | C(Hybrid — cả UI và backend)

━━━ OUTPUT FORMAT ━━━
PHẢI xuất JSON trong markdown code block:
\`\`\`json
{
  "decision": "SIMPLE" | "CODE_TEAM",
  "reasoning": "<lý do ngắn gọn>",
  "routing": {
    "mode": "A" | "B" | "C",
    "tier": 1 | 2 | 3,
    "score": <3-9>,
    "reasoning": "<giải thích routing>"
  },
  "suggestion": "<gợi ý ngắn cho user nếu CODE_TEAM, tiếng Việt>",
  "directAnswer": "<câu trả lời trực tiếp nếu SIMPLE, tiếng Việt>"
}
\`\`\`

QUAN TRỌNG:
- Nếu SIMPLE → routing có thể null, PHẢI có directAnswer
- Nếu CODE_TEAM → PHẢI có routing + suggestion
- suggestion phải bằng tiếng Việt, ngắn gọn, thân thiện
- directAnswer phải bằng tiếng Việt, hữu ích nhưng ngắn (không dài quá 3 câu)`

// ==================== MAIN ASSESSMENT FUNCTION ====================

/**
 * Assess whether a user request needs Code Team workflow.
 *
 * This is the core of the Smart TL Bridge (C2 resolution).
 * TL evaluates the request and returns:
 *   - SIMPLE: TL can answer directly, no workflow needed
 *   - CODE_TEAM: Request needs multi-agent workflow, returns routing suggestion
 *
 * @param userMessage - The user's current message
 * @param chatHistory - Recent chat history for context (last 6 messages recommended)
 * @param timeoutMs - Maximum time to wait for assessment (default: 5000ms)
 * @returns TLAssessment with decision and optional routing
 */
export async function assessRequest(
  userMessage: string,
  chatHistory: Array<{ role: string; content: string }> = [],
  timeoutMs: number = 15000,
): Promise<TLAssessment> {
  // Check cache first
  const cached = getCachedAssessment(userMessage)
  if (cached) {
    console.log('[TLBridge] Using cached assessment')
    return cached
  }

  try {
    // Resolve TL agent — uses Agent Resolution Layer (C1)
    const tlAgent = await resolveAgent('TL')

    if (tlAgent.source === 'missing' || !tlAgent.provider || !tlAgent.model) {
      console.warn('[TLBridge] TL agent not available, falling back to SIMPLE')
      return {
        decision: 'SIMPLE',
        reasoning: 'TL agent không khả dụng. Không thể đánh giá request.',
        directAnswer: 'Xin lỗi, tôi không thể đánh giá yêu cầu lúc này. Vui lòng thử lại sau.',
      }
    }

    // Build assessment prompt with chat history
    const truncatedMessage = userMessage.length > MAX_USER_MESSAGE_LENGTH
      ? userMessage.slice(0, MAX_USER_MESSAGE_LENGTH) + '\n... (tin nhắn đã được rút gọn)'
      : userMessage

    const historyText = chatHistory
      .slice(-6) // Last 6 messages for context
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 200)}`)
      .join('\n')

    const fullPrompt = historyText
      ? `Chat history:\n${historyText}\n\nCurrent message: ${truncatedMessage}`
      : `User message: ${truncatedMessage}`

    // Call TL with timeout protection
    const result = await callLLMWithTimeout(
      fullPrompt,
      { provider: tlAgent.provider, model: tlAgent.model },
      TL_ASSESSMENT_PROMPT,
      { maxTokens: 1024, temperature: 0.3 },
      timeoutMs,
    )

    // Parse assessment from LLM output
    const assessment = parseAssessment(result)

    // Cache the result
    setCachedAssessment(userMessage, assessment)

    console.log(`[TLBridge] Assessment: ${assessment.decision}${assessment.routing ? ` (Mode ${assessment.routing.mode}, Tier ${assessment.routing.tier}, Score ${assessment.routing.score})` : ''} — ${assessment.reasoning.slice(0, 100)}`)

    return assessment
  } catch (err) {
    console.error('[TLBridge] Assessment failed:', err instanceof Error ? err.message : String(err))
    // Fallback: Return SIMPLE on error — don't trigger workflow on failure
    return {
      decision: 'SIMPLE',
      reasoning: `Assessment failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      directAnswer: undefined,
    }
  }
}

// ==================== TIMEOUT PROTECTION ====================

/**
 * Call LLM with timeout — if assessment takes too long, fall back.
 * This prevents the chat from hanging if LLM is slow.
 */
async function callLLMWithTimeout(
  prompt: string,
  agentConfig: { provider: string; model: string },
  systemPrompt: string,
  options: { maxTokens?: number; temperature?: number },
  timeoutMs: number,
): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Assessment timeout after ${timeoutMs}ms`)), timeoutMs)
  })

  try {
    const llmPromise = callLLMForAgent(prompt, agentConfig, systemPrompt, options)
    const result = await Promise.race([llmPromise, timeoutPromise])

    if (result.error && !result.content) {
      throw new Error(`LLM call failed: ${result.error}`)
    }

    return result.content
  } finally {
    // Always clear timeout to prevent resource leak
    if (timeoutId) clearTimeout(timeoutId)
  }
}

// ==================== ASSESSMENT PARSER ====================

/**
 * Parse TL Assessment from LLM output.
 *
 * Strategy:
 *   1. Find JSON in markdown code block
 *   2. Find raw JSON object containing "decision" key
 *   3. Fallback: keyword-based heuristic
 */
export function parseAssessment(output: string): TLAssessment {
  // Strategy 1: JSON in markdown code block
  const jsonMatch = output.match(/```json\s*([\s\S]*?)```/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1])
      return normalizeAssessment(parsed)
    } catch {
      // JSON parse failed, try next strategy
    }
  }

  // Strategy 2: Raw JSON object with "decision" key
  const rawJsonMatch = findBalancedJson(output, '"decision"')
  if (rawJsonMatch) {
    try {
      const parsed = JSON.parse(rawJsonMatch)
      return normalizeAssessment(parsed)
    } catch {
      // JSON parse failed
    }
  }

  // Strategy 3: Keyword-based heuristic
  return heuristicAssessment(output)
}

/**
 * Normalize parsed assessment — validate and default fields.
 */
function normalizeAssessment(parsed: Record<string, unknown>): TLAssessment {
  const decision = parsed.decision === 'CODE_TEAM' ? 'CODE_TEAM' : 'SIMPLE'

  const assessment: TLAssessment = {
    decision,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  }

  if (decision === 'CODE_TEAM') {
    // Parse routing
    const routing = parsed.routing as Record<string, unknown> | undefined
    if (routing) {
      const validModes = ['A', 'B', 'C'] as const
      const validTiers = [1, 2, 3] as const

      assessment.routing = {
        mode: validModes.includes(routing.mode as typeof validModes[number])
          ? (routing.mode as 'A' | 'B' | 'C')
          : 'B',
        tier: validTiers.includes(routing.tier as typeof validTiers[number])
          ? (routing.tier as 1 | 2 | 3)
          : 2,
        score: typeof routing.score === 'number'
          ? Math.min(9, Math.max(3, routing.score))
          : 5,
        reasoning: typeof routing.reasoning === 'string' ? routing.reasoning : '',
      }
    } else {
      // Default routing when CODE_TEAM but no routing provided
      assessment.routing = {
        mode: 'B',
        tier: 2,
        score: 5,
        reasoning: 'Mặc định: Mode B (Backend), Tier 2 (Medium)',
      }
    }

    assessment.suggestion = typeof parsed.suggestion === 'string'
      ? parsed.suggestion
      : 'MEGATRON đề xuất sử dụng Code Team để xử lý yêu cầu này.'
  } else {
    // SIMPLE
    assessment.directAnswer = typeof parsed.directAnswer === 'string'
      ? parsed.directAnswer
      : undefined
  }

  return assessment
}

/**
 * Heuristic assessment — used when LLM output can't be parsed.
 * Makes a best-effort decision based on keywords in the output.
 */
function heuristicAssessment(output: string): TLAssessment {
  const lower = output.toLowerCase()

  // Keywords suggesting CODE_TEAM
  const codeTeamKeywords = [
    'code_team', 'workflow', 'pipeline', 'code team',
    'architecture', 'implement', 'triển khai', 'phát triển',
    'code', 'build', 'develop', 'tạo tính năng', 'sửa bug',
    'xây dựng', 'refactor', 'tối ưu',
  ]

  const isCodeTeam = codeTeamKeywords.some(kw => lower.includes(kw))

  if (isCodeTeam) {
    return {
      decision: 'CODE_TEAM',
      reasoning: 'Heuristic: Keywords suggest Code Team workflow needed',
      routing: {
        mode: 'B',
        tier: 2,
        score: 5,
        reasoning: 'Heuristic default',
      },
      suggestion: 'MEGATRON đề xuất sử dụng Code Team để xử lý yêu cầu này.',
    }
  }

  return {
    decision: 'SIMPLE',
    reasoning: 'Heuristic: No Code Team keywords detected, treating as simple chat',
  }
}

/**
 * Find balanced JSON object containing a specific key.
 * Copied from worklog.ts for local use (avoids circular dependency).
 */
function findBalancedJson(text: string, requiredKey: string): string | null {
  const keyIndex = text.indexOf(requiredKey)
  if (keyIndex === -1) return null

  // Walk backwards to find opening brace
  let startBrace = -1
  let depth = 0
  for (let i = keyIndex; i >= 0; i--) {
    if (text[i] === '}') depth++
    if (text[i] === '{') {
      depth--
      if (depth < 0) {
        startBrace = i
        break
      }
    }
  }
  if (startBrace === -1) return null

  // Walk forward to find matching closing brace
  depth = 0
  let inString = false
  let escape = false

  for (let i = startBrace; i < text.length; i++) {
    const ch = text[i]

    if (escape) {
      escape = false
      continue
    }

    if (ch === '\\' && inString) {
      escape = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (!inString) {
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          return text.slice(startBrace, i + 1)
        }
      }
    }
  }

  return null
}

// ==================== KEYWORD MATCHING (BACKWARD COMPAT) ====================

/**
 * Official trigger keywords — backward compatible with Phase 1.
 *
 * IMPORTANT: "tiến hành triển khai" is the OFFICIAL keyword to trigger
 * the multi-agents workflow. These keywords trigger workflow DIRECTLY,
 * bypassing the TL assessment (for backward compatibility).
 */
const DIRECT_TRIGGER_KEYWORDS = [
  'tiến hành triển khai',
]

/**
 * Check if a message contains the official workflow trigger keyword.
 * If true → trigger workflow directly, bypass TL assessment.
 * This preserves backward compatibility with Phase 1.
 */
export function isDirectTrigger(message: string): boolean {
  const lower = message.toLowerCase().trim()
  return DIRECT_TRIGGER_KEYWORDS.some(kw => lower.includes(kw))
}

/**
 * Convert TLAssessment to RoutingDecision for workflow engine.
 * Used when user accepts the Suggestion Card (Phase 3).
 *
 * IMPORTANT: For Mode C (Hybrid), creates 2 parts:
 *   - Part 1: 'visual' — TL codes UI via Fast Track
 *   - Part 2: 'backend' — Pipeline handles backend
 * This matches the workflow doc: "TL(UI) ‖ G1→G2-A→G2-B(BE) → G3(integration) → TL"
 */
export function assessmentToRoutingDecision(
  assessment: TLAssessment,
  userRequest: string,
): RoutingDecision | null {
  if (assessment.decision !== 'CODE_TEAM' || !assessment.routing) {
    return null
  }

  const mode = assessment.routing.mode

  // Build parts based on routing mode
  let parts: RoutingDecision['parts']
  if (mode === 'A') {
    // Pure Visual — single visual part
    parts = [{
      name: 'visual',
      type: 'visual',
      description: userRequest,
      dependency: [],
    }]
  } else if (mode === 'C') {
    // Hybrid — 2 parts: visual (TL Fast Track) + backend (pipeline)
    parts = [
      {
        name: 'visual',
        type: 'visual',
        description: `Phần giao diện UI/UX: ${userRequest}`,
        dependency: [],
      },
      {
        name: 'backend',
        type: 'backend',
        description: `Phần backend/logic: ${userRequest}`,
        dependency: ['visual'], // Backend depends on UI being coded first
      },
    ]
  } else {
    // Pure Backend (Mode B) — single backend part
    parts = [{
      name: 'backend',
      type: 'backend',
      description: userRequest,
      dependency: [],
    }]
  }

  return {
    mode,
    tier: assessment.routing.tier,
    score: assessment.routing.score,
    reasoning: assessment.routing.reasoning || assessment.reasoning,
    parts,
    spec: userRequest,
  }
}
