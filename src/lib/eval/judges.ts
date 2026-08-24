// Phase 4 SMOLAB Proposal 11' — Cross-model judges.
//
// 3 judges from DIFFERENT model families (reduces circular bias vs single
// model — a single judge that shares training data / lineage with the answer
// generator tends to rubber-stamp its own output). Judge 3 uses a binary
// rubric (3 Y/N checks averaged) — easier for LLMs to answer reliably and less
// biased than free-form 0-1 scoring.
//
// Env-driven provider selection (no keys present in this deployment by default):
//   - OPENAI_API_KEY set   → judge 1 = OpenAI gpt-4o-mini (direct API call)
//   - ANTHROPIC_API_KEY set → judge 2 = Anthropic claude-3-5-haiku (direct API call)
//   Otherwise both fall back to NVIDIA NIM models from DIFFERENT families:
//   1. openai/gpt-oss-120b                — free-form (OpenAI family, NIM-hosted)
//   2. moonshotai/kimi-k3                 — free-form (Moonshot family)
//   3. minimaxai/minimax-m3               — BINARY RUBRIC (MiniMax family)
//
// Post-fix note (2026-08-24): judge 3 was originally z-ai/glm-5.2 (HTTP 410
// Gone on NIM), then deepseek-v4-flash-0731 — which HANGS (>120s timeout,
// verified via direct curl). Replaced with minimax-m3: direct-tested HTTP 200
// in ~20s. Also maxTokens raised 32/64 → 512: gpt-oss-120b is a reasoning
// model whose reasoning tokens count against max_tokens — at 32 the entire
// budget was consumed by reasoning, leaving content empty (HTTP 200 but empty
// reply → judge "failed"). 512 gives reasoning + a short answer room. NVIDIA
// judge calls also get ONE retry (kimi-k3 returns intermittent 404s —
// likely per-key rate limiting; a second attempt usually lands on a healthy
// key).
//
// The answer-generation model (system-under-test) is nvidia/nemotron-3-ultra-550b-a55b
// (see runner.ts) — different from ALL judges.
//
// Failure semantics: each judge call is wrapped in try/catch. A failed judge
// gets score = -1 and is EXCLUDED from the median. 2+ failures → median is the
// one remaining score; ALL fail → median = 0.5 (neutral). The scores array
// keeps -1 sentinels so EvalResult.faithfulnessScores reveals which judge failed.

import { callLLM } from '@/lib/llm'

export interface JudgeResult {
  /** 0-1 score, or -1 when this judge failed (excluded from median). */
  score: number
  /** Short judge explanation / error message. */
  reasoning: string
  /** Human-readable judge identity (provider/model actually used). */
  judgeName: string
}

export interface JudgeVerdict {
  /** Robust aggregate of the 3 judge scores (median of the valid ones). */
  median: number
  /** All 3 scores in judge order — -1 = that judge failed. */
  scores: number[]
  /** Judge identities in the same order as scores. */
  judges: string[]
  /** Judge reasoning / error messages in the same order. */
  reasoning: string[]
}

// ==================== JUDGE CONFIGURATION ====================

type JudgeProvider = 'nvidia' | 'openai' | 'anthropic'

interface JudgeConfig {
  provider: JudgeProvider
  /** Primary model for this judge slot. */
  model: string
  /** NVIDIA NIM fallback model when the primary provider fails (env-key providers only). */
  nvidiaFallback?: string
  /** true = binary rubric (3 Y/N checks); false = free-form 0-1 score. */
  binaryRubric: boolean
}

/** Judge 1 — free-form. OpenAI gpt-4o-mini when OPENAI_API_KEY exists,
 *  else NVIDIA NIM openai/gpt-oss-120b (OpenAI family, cross-hosted). */
function judge1Config(): JudgeConfig {
  if (process.env.OPENAI_API_KEY) {
    return { provider: 'openai', model: 'gpt-4o-mini', nvidiaFallback: 'openai/gpt-oss-120b', binaryRubric: false }
  }
  return { provider: 'nvidia', model: 'openai/gpt-oss-120b', binaryRubric: false }
}

/** Judge 2 — free-form. Anthropic claude-3-5-haiku when ANTHROPIC_API_KEY
 *  exists, else NVIDIA NIM moonshotai/kimi-k3 (Moonshot family). */
function judge2Config(): JudgeConfig {
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: 'anthropic', model: 'claude-3-5-haiku-20241022', nvidiaFallback: 'moonshotai/kimi-k3', binaryRubric: false }
  }
  return { provider: 'nvidia', model: 'moonshotai/kimi-k3', binaryRubric: false }
}

/** Judge 3 — BINARY RUBRIC. Always NVIDIA NIM minimax-m3 (MiniMax family).
 *  (Originally z-ai/glm-5.2 — HTTP 410 Gone; then deepseek-v4-flash — hangs
 *  >120s on NIM as of 2026-08-24. minimax-m3 direct-tested: HTTP 200 in ~20s.) */
function judge3Config(): JudgeConfig {
  return { provider: 'nvidia', model: 'minimaxai/minimax-m3', binaryRubric: true }
}

// ==================== PROMPTS ====================

/** Shared refusal instruction for negative (out-of-domain) cases. */
const NEGATIVE_INSTRUCTION =
  '\nThe expected answer is a refusal ("I don\'t know"). Score 1.0 if the actual answer also appropriately declines to answer with unsupported details, 0.0 if it hallucinates specifics.\n'

function freeFormPrompt(question: string, expected: string, actual: string, isNegativeCase: boolean): string {
  return (
    `You are an impartial evaluator scoring an answer's faithfulness.\n\n` +
    `Question: ${question}\n\n` +
    `Expected answer: ${expected}\n\n` +
    `Actual answer: ${actual}\n\n` +
    (isNegativeCase ? NEGATIVE_INSTRUCTION : '') +
    `Score 0.0-1.0 how faithful the actual answer is to the expected answer (1.0 = fully covers expected facts, 0.0 = completely wrong). Reply with ONLY the number.`
  )
}

function binaryRubricPrompt(question: string, expected: string, actual: string, isNegativeCase: boolean): string {
  const check3 = isNegativeCase
    ? 'Does the actual answer appropriately say it does not know instead of guessing?'
    : 'Does the actual answer avoid hallucinating facts not present in the expected answer?'
  return (
    `You are an impartial evaluator. Check the actual answer against the expected answer with a binary rubric.\n\n` +
    `Question: ${question}\n\n` +
    `Expected answer: ${expected}\n\n` +
    `Actual answer: ${actual}\n\n` +
    (isNegativeCase ? NEGATIVE_INSTRUCTION : '') +
    `Check 1: Does the actual answer mention the key facts from the expected answer? (Y/N)\n` +
    `Check 2: Is the actual answer free from contradictions with the expected answer? (Y/N)\n` +
    `Check 3: ${check3} (Y/N)\n\n` +
    `Reply with exactly 3 lines, each containing ONLY the letter 'Y' or 'N' (line 1 = Check 1, line 2 = Check 2, line 3 = Check 3).`
  )
}

// ==================== PARSING ====================

/** Parse a free-form 0-1 score from a judge reply. Throws when unparseable. */
function parseFreeFormScore(content: string): number {
  const match = content.match(/(\d+(?:\.\d+)?)/)
  if (!match) throw new Error(`no numeric score in judge reply: "${content.slice(0, 80)}"`)
  const score = parseFloat(match[1])
  if (Number.isNaN(score)) throw new Error(`NaN score in judge reply: "${content.slice(0, 80)}"`)
  return Math.max(0, Math.min(1, score))
}

/** Parse the 3 Y/N lines from a binary-rubric judge reply. Throws when
 *  fewer than 1 Y/N token is found. Score = yesCount / 3. */
function parseBinaryRubricScore(content: string): number {
  const tokens = content.toUpperCase().match(/\b[YN]\b/g)
  if (!tokens || tokens.length === 0) {
    throw new Error(`no Y/N tokens in judge reply: "${content.slice(0, 80)}"`)
  }
  const first3 = tokens.slice(0, 3)
  const yesCount = first3.filter((t) => t === 'Y').length
  return yesCount / 3
}

// ==================== PROVIDER CALLS ====================

/** Direct OpenAI chat-completions call (only used when OPENAI_API_KEY is set). */
async function callOpenAI(prompt: string, model: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`)
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('OpenAI returned empty content')
  return content
}

/** Direct Anthropic messages call (only used when ANTHROPIC_API_KEY is set). */
async function callAnthropic(prompt: string, model: string, maxTokens: number): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': String(process.env.ANTHROPIC_API_KEY),
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`)
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
  const text = data.content?.find((c) => c.type === 'text')?.text
  if (!text) throw new Error('Anthropic returned empty content')
  return text
}

/** NVIDIA NIM call via the app's callLLM infra with an explicit model override
 *  (llm.ts Prop 11' option). Tries all 4 keys round-robin — NO pool rotation
 *  fallback, so the judge identity is guaranteed. ONE retry on failure:
 *  kimi-k3 returns intermittent 404s (per-key rate limiting) — a second
 *  attempt usually lands on a healthy key. */
async function callNvidia(prompt: string, model: string, maxTokens: number): Promise<string> {
  let lastError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callLLM(prompt, undefined, 'eval-judge', {
      model,
      temperature: 0,
      maxTokens,
    })
    if (!result.error && result.content) {
      if (result.model && result.model !== model) {
        throw new Error(`judge model drift: expected ${model}, got ${result.model}`)
      }
      return result.content
    }
    lastError = result.error || 'NVIDIA judge returned empty content'
    console.warn(`[Eval-Judge] ${model} attempt ${attempt + 1} failed (${lastError})${attempt === 0 ? ' — retrying once' : ''}`)
  }
  throw new Error(lastError)
}

// ==================== SINGLE JUDGE EXECUTION ====================

async function runSingleJudge(
  config: JudgeConfig,
  question: string,
  expected: string,
  actual: string,
  isNegativeCase: boolean
): Promise<JudgeResult> {
  const prompt = config.binaryRubric
    ? binaryRubricPrompt(question, expected, actual, isNegativeCase)
    : freeFormPrompt(question, expected, actual, isNegativeCase)
  // Reasoning models (gpt-oss-120b) burn reasoning tokens against max_tokens
  // before emitting content — 32/64 left content empty. 512 covers reasoning +
  // the tiny answer (a number or 3 Y/N lines).
  const maxTokens = 512

  let content: string
  try {
    if (config.provider === 'openai') {
      try {
        content = await callOpenAI(prompt, config.model, maxTokens)
      } catch (err) {
        // OpenAI key exists but call failed → fall back to the NVIDIA NIM
        // model reserved for this judge slot (keeps 3 independent scores).
        console.warn(
          `[Eval-Judge] OpenAI ${config.model} failed (${err instanceof Error ? err.message : String(err)}) — falling back to NVIDIA ${config.nvidiaFallback}`
        )
        content = await callNvidia(prompt, config.nvidiaFallback ?? config.model, maxTokens)
        return {
          score: config.binaryRubric ? parseBinaryRubricScore(content) : parseFreeFormScore(content),
          reasoning: content.trim().slice(0, 300),
          judgeName: `nvidia/${config.nvidiaFallback ?? config.model}`,
        }
      }
    } else if (config.provider === 'anthropic') {
      try {
        content = await callAnthropic(prompt, config.model, maxTokens)
      } catch (err) {
        console.warn(
          `[Eval-Judge] Anthropic ${config.model} failed (${err instanceof Error ? err.message : String(err)}) — falling back to NVIDIA ${config.nvidiaFallback}`
        )
        content = await callNvidia(prompt, config.nvidiaFallback ?? config.model, maxTokens)
        return {
          score: config.binaryRubric ? parseBinaryRubricScore(content) : parseFreeFormScore(content),
          reasoning: content.trim().slice(0, 300),
          judgeName: `nvidia/${config.nvidiaFallback ?? config.model}`,
        }
      }
    } else {
      content = await callNvidia(prompt, config.model, maxTokens)
    }
  } catch (err) {
    // Total judge failure (incl. NVIDIA fallback) → -1 sentinel, excluded from median.
    return {
      score: -1,
      reasoning: `judge failed: ${err instanceof Error ? err.message : String(err)}`,
      judgeName: `${config.provider}/${config.model}`,
    }
  }

  const score = config.binaryRubric ? parseBinaryRubricScore(content) : parseFreeFormScore(content)
  return {
    score,
    reasoning: content.trim().slice(0, 300),
    judgeName: `${config.provider}/${config.model}`,
  }
}

// ==================== PUBLIC API ====================

/**
 * Score an actual answer against the expected answer using 3 cross-family
 * judges. Returns the median (robust aggregate) + all raw scores.
 *
 * @param question      Eval case question
 * @param expected      Golden expected answer
 * @param actual        System-under-test answer
 * @param isNegativeCase true when the case is out-of-domain (expected = refusal)
 */
export async function judgeAnswer(
  question: string,
  expected: string,
  actual: string,
  isNegativeCase: boolean
): Promise<JudgeVerdict> {
  const configs = [judge1Config(), judge2Config(), judge3Config()]

  // Run the 3 judges sequentially (not Promise.all) — gentler on NVIDIA rate
  // limits: the eval runner already fires retrieval + generation before this,
  // and cases are paced 300ms apart.
  const results: JudgeResult[] = []
  for (const config of configs) {
    results.push(await runSingleJudge(config, question, expected, actual, isNegativeCase))
  }

  const scores = results.map((r) => r.score)
  const valid = scores.filter((s) => s >= 0).sort((a, b) => a - b)

  let median: number
  if (valid.length === 0) {
    median = 0.5 // all judges failed — neutral
  } else if (valid.length % 2 === 1) {
    median = valid[(valid.length - 1) / 2]
  } else {
    // Even count (a judge failed) — mean of the two middle values.
    const hi = valid.length / 2
    median = (valid[hi - 1] + valid[hi]) / 2
  }

  return {
    median,
    scores,
    judges: results.map((r) => r.judgeName),
    reasoning: results.map((r) => r.reasoning),
  }
}
