/**
 * Smart KB Routing — Layer 1: Intent Classifier
 *
 * Classifies user message into one of:
 *   - casual: greetings, chit-chat, confirmations (skip KB entirely)
 *   - factual: needs knowledge lookup (run 2-step KB access)
 *   - procedural: code/how-to (route to Code Team)
 *   - meta: asks about agent itself (use AgentProfile)
 *
 * Strategy:
 *   1. Rule-based (fast, 0ms, covers 80% of cases)
 *   2. LLM fallback (only when rules inconclusive — saves tokens)
 *
 * Phase 4 of design doc.
 */

export type Intent = 'casual' | 'factual' | 'procedural' | 'meta'

export interface IntentResult {
  intent: Intent
  confidence: number  // 0-1 — how sure we are
  source: 'rule' | 'llm'  // which classifier decided
  reason?: string  // for debugging
}

// ==================== RULE-BASED CLASSIFIER ====================

const CASUAL_PATTERNS = [
  /^(hi|hello|hey|yo|sup|chào|xin chào|chao|alo|halo)\b/i,
  /^(ok|okay|ok rồi|được rồi|được|vâng|ừm|uh|hmm)\b/i,
  /^(cảm ơn|cám ơn|thanks|thank you|ty|tks)\b/i,
  /^(bye|tạm biệt|tam biet|goodbye|see you)\b/i,
  /^(yes|no|có|không|đúng|sai)\b/i,
  /^(hihi|haha|lol|kk|😊|👍|❤️)/i,
]

const PROCEDURAL_PATTERNS = [
  /\b(how to|how do i|how can i|how does|how would|làm thế nào|làm sao|làm cách nào)\b/i,
  /\b(tutorial|hướng dẫn|huong dan|step by step|từng bước)\b/i,
  /\b(write code|viết code|fix bug|sửa lỗi|implement|tạo function|implement|refactor)\b/i,
  /\b(file|folder|directory|class|function|method|api|endpoint)\s+\w+/i,
  /```/, // code block
  /\b(git|npm|yarn|bun|docker|kubectl)\s+(install|run|build|create)\b/i,
]

const META_PATTERNS = [
  /\b(bạn là ai|bạn tên gì|tên bạn là gì|bạn có thể làm gì|what can you do|who are you)\b/i,
  /\b(bạn dùng model gì|bạn dùng lõi gì|which model do you use)\b/i,
  /\b(tại sao bạn|why do you|how do you work)\b/i,
]

/**
 * Fast rule-based intent classifier.
 * Returns null if no rule matches (then LLM fallback needed).
 */
function classifyByRule(message: string): IntentResult | null {
  const trimmed = message.trim()

  // Short messages (< 15 chars) are usually casual
  if (trimmed.length < 15 && !/[??:]/.test(trimmed)) {
    if (CASUAL_PATTERNS.some(p => p.test(trimmed))) {
      return { intent: 'casual', confidence: 0.9, source: 'rule', reason: 'short + casual pattern' }
    }
    if (trimmed.length < 8) {
      return { intent: 'casual', confidence: 0.7, source: 'rule', reason: 'very short message' }
    }
  }

  // Check explicit casual patterns (longer greetings)
  if (CASUAL_PATTERNS.some(p => p.test(trimmed))) {
    return { intent: 'casual', confidence: 0.85, source: 'rule', reason: 'casual pattern matched' }
  }

  // Check meta patterns (asks about agent itself)
  if (META_PATTERNS.some(p => p.test(trimmed))) {
    return { intent: 'meta', confidence: 0.85, source: 'rule', reason: 'meta pattern matched' }
  }

  // Check procedural patterns (code/how-to)
  if (PROCEDURAL_PATTERNS.some(p => p.test(trimmed))) {
    return { intent: 'procedural', confidence: 0.85, source: 'rule', reason: 'procedural pattern matched' }
  }

  // Has question mark → likely factual
  if (/[?？]/.test(trimmed) && trimmed.length > 20) {
    return { intent: 'factual', confidence: 0.7, source: 'rule', reason: 'question mark + length' }
  }

  // Default: ambiguous — let LLM decide
  return null
}

// ==================== LLM FALLBACK CLASSIFIER ====================

/**
 * LLM-based intent classifier. Used only when rule-based returns null.
 * Uses a small/cheap model call with very short prompt.
 */
async function classifyByLLM(message: string): Promise<IntentResult> {
  // Lazy import to avoid Edge bundler issues
  // UTILITY CORE (user report 2026-09-05): intent classification là tiền xử lý
  // phân loại — dùng lõi utility (nemotron→gpt-oss), không đụng kimi-k3
  // (tránh query module treo 15' xoay vòng khi NVIDIA block kimi).
  const { callUtilityLLM } = await import('@/lib/llm')

  const prompt = `Classify this user message into exactly ONE category. Reply with ONLY the category name, nothing else.

Categories:
- casual: greetings, chit-chat, jokes, thanks, confirmations (no info needed)
- factual: asking for facts, definitions, explanations, comparisons (needs knowledge lookup)
- procedural: how-to, code requests, tutorials (needs step-by-step or code)
- meta: asks about the AI assistant itself (capabilities, identity)

User message: "${message.slice(0, 500)}"

Category:`

  try {
    const result = await callUtilityLLM(prompt, undefined, 'intent-classification', {
      temperature: 0.0,
      maxTokens: 10,
    })

    const text = (result.content || '').trim().toLowerCase()
    const validIntents: Intent[] = ['casual', 'factual', 'procedural', 'meta']

    // Find which intent the LLM picked
    const matched = validIntents.find(i => text.includes(i))
    if (matched) {
      return {
        intent: matched,
        confidence: 0.75,
        source: 'llm',
        reason: `LLM classified as ${matched}`,
      }
    }

    // LLM returned gibberish — default to factual (safe)
    return {
      intent: 'factual',
      confidence: 0.5,
      source: 'llm',
      reason: 'LLM unclear, defaulting to factual',
    }
  } catch (err) {
    console.warn('[IntentClassifier] LLM fallback failed:', err instanceof Error ? err.message : String(err))
    return {
      intent: 'factual',
      confidence: 0.4,
      source: 'llm',
      reason: `LLM error: ${err instanceof Error ? err.message : 'unknown'}`,
    }
  }
}

// ==================== MAIN ENTRY ====================

/**
 * Classify the intent of a user message.
 * Tries rule-based first (fast), falls back to LLM if ambiguous.
 *
 * @param message - User message to classify
 * @param options - Optional config:
 *   - skipLLMFallback: if true, default to 'factual' instead of calling LLM (for fast chat path)
 */
export async function classifyIntent(
  message: string,
  options?: { skipLLMFallback?: boolean }
): Promise<IntentResult> {
  // Step 1: Try rule-based (fast, 0ms)
  const ruleResult = classifyByRule(message)
  if (ruleResult) {
    return ruleResult
  }

  // Step 2: If LLM fallback skipped (e.g., chat route for speed), default to factual
  if (options?.skipLLMFallback) {
    return {
      intent: 'factual',
      confidence: 0.5,
      source: 'rule',
      reason: 'No rule matched, defaulted to factual (LLM fallback skipped)',
    }
  }

  // Step 3: LLM fallback (only when rules inconclusive and not skipped)
  return classifyByLLM(message)
}

/**
 * Quick check: should this message skip KB access entirely?
 * Useful as a fast-path before running expensive KB queries.
 */
export function shouldSkipKB(message: string): boolean {
  const ruleResult = classifyByRule(message)
  if (ruleResult) {
    return ruleResult.intent === 'casual'
  }
  return false // unknown — don't skip (let KB decide)
}
