// Phase 4 SMOLAB Proposal 11' — Cross-model judges.
//
// ⚠ USER DIRECTIVE 2026-11-30 (model matrix mới — thay thế matrix NIM 3 họ cũ):
//   "Mặc định judges nếu kimi-k3 sống thì dùng k3 còn không thì dùng
//    space-bunny-free cũng được."
//   → MỖI judge slot: PRIMARY = NVIDIA NIM moonshotai/kimi-k3; khi kimi-k3
//   fail (429 kéo dài / hang / EOL) → FALLBACK = OpenCode Zen space-bunny-free
//   (chuỗi HTTP → CLI của callLLM). judgeName phản ánh model THỰC TẾ dùng.
//
//   Lịch sử (đã EOL — loại bỏ 2026-11-30, live-probe 410 toàn bộ):
//   judge 1 gpt-oss-120b (EOL 2026-09-03) · judge 3 minimax-m3 (EOL
//   2026-09-09) · deepseek-v4-flash từng là answer model (EOL 2026-09-21).
//   OpenAI/Anthropic direct branches gỡ luôn (không có OPENAI_API_KEY /
//   ANTHROPIC_API_KEY trong deploy này — dead code).
//
// 3 judge slot được GIỮ (median của 3 + judge 3 dùng binary rubric 3 Y/N —
// dễ trả lời tin cậy hơn free-form 0-1). Cross-model khi có thể: answer
// model (system-under-test) = space-bunny-free (runner.ts) ≠ judge primary
// kimi-k3. Khi kimi-k3 chết, judges fallback SBF trùng answer model —
// circular bias tăng (không tránh được với matrix hiện tại — đánh đổi đúng
// theo directive user: "space-bunny-free cũng được").
//
// Live-probe 2026-11-30: kimi-k3 ALIVE nhưng chậm (~120s cho prompt tối giản
// — cần timeout dài); maxTokens 512 giữ nguyên (kimi-k3 là reasoning model —
// reasoning tokens trừ vào max_tokens, 32/64 để lại content rỗng như cũ).
//
// Failure semantics: mỗi judge call bọc try/catch. Judge fail → score = -1,
// EXCLUDED khỏi median. 2+ fail → median = score còn lại; ALL fail →
// median = 0.5 (neutral). scores array giữ -1 sentinel để
// EvalResult.faithfulnessScores cho biết judge nào chết.

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

/** Judge primary — NVIDIA NIM kimi-k3 (user directive 2026-11-30: "nếu
 *  kimi-k3 sống thì dùng k3"). Chậm (~120s/call live-probe 2026-11-30). */
const JUDGE_PRIMARY_MODEL = 'moonshotai/kimi-k3'

/** Judge fallback — OpenCode Zen space-bunny-free (user directive 2026-11-30:
 *  "còn không thì dùng space-bunny-free cũng được"). */
const JUDGE_FALLBACK_MODEL = 'space-bunny-free'

interface JudgeConfig {
  /** Primary model for this judge slot (NIM kimi-k3). */
  model: string
  /** Zen fallback model when the primary fails. */
  fallbackModel: string
  /** true = binary rubric (3 Y/N checks); false = free-form 0-1 score. */
  binaryRubric: boolean
}

/** Judge 1 — free-form. kimi-k3 (primary) → space-bunny-free (fallback). */
function judge1Config(): JudgeConfig {
  return { model: JUDGE_PRIMARY_MODEL, fallbackModel: JUDGE_FALLBACK_MODEL, binaryRubric: false }
}

/** Judge 2 — free-form. kimi-k3 (primary) → space-bunny-free (fallback). */
function judge2Config(): JudgeConfig {
  return { model: JUDGE_PRIMARY_MODEL, fallbackModel: JUDGE_FALLBACK_MODEL, binaryRubric: false }
}

/** Judge 3 — BINARY RUBRIC. kimi-k3 (primary) → space-bunny-free (fallback). */
function judge3Config(): JudgeConfig {
  return { model: JUDGE_PRIMARY_MODEL, fallbackModel: JUDGE_FALLBACK_MODEL, binaryRubric: true }
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

/** Judge model call: primary (NIM kimi-k3) → fallback (Zen space-bunny-free).
 *  callLLM với model override route đúng transport: id NIM → xoay vòng 4 key
 *  NIM (circuit breaker tự trip khi hang/429); id zen → callZenProvider
 *  (HTTP → CLI). Trả về content + judgeName nói thật model nào đã trả lời.
 *  Throws khi cả 2 đều fail (caller bắt → score -1). */
async function callJudgeModel(prompt: string, maxTokens: number): Promise<{ content: string; judgeName: string }> {
  // Primary — NVIDIA NIM kimi-k3. 2 attempts (fail nhanh 429/EOL thì thử lại
  // 1 lần; kimi-k3 từng trả 404/429 theo key — attempt 2 thường sang key khỏe).
  let lastPrimaryError = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callLLM(prompt, undefined, 'eval-judge', {
      model: JUDGE_PRIMARY_MODEL,
      temperature: 0,
      maxTokens,
    })
    if (!result.error && result.content) {
      if (result.model && result.model !== JUDGE_PRIMARY_MODEL) {
        throw new Error(`judge model drift: expected ${JUDGE_PRIMARY_MODEL}, got ${result.model}`)
      }
      return { content: result.content, judgeName: `nvidia/${JUDGE_PRIMARY_MODEL}` }
    }
    lastPrimaryError = result.error || 'NVIDIA judge returned empty content'
    console.warn(`[Eval-Judge] ${JUDGE_PRIMARY_MODEL} attempt ${attempt + 1} failed (${lastPrimaryError})${attempt === 0 ? ' — retrying once' : ''}`)
  }

  // Fallback — Zen space-bunny-free (user directive 2026-11-30)
  console.warn(`[Eval-Judge] kimi-k3 thất bại (${lastPrimaryError.slice(0, 100)}) — fallback ${JUDGE_FALLBACK_MODEL} (Zen) theo user directive 2026-11-30`)
  const fallback = await callLLM(prompt, undefined, 'eval-judge-fallback', {
    model: JUDGE_FALLBACK_MODEL,
    temperature: 0,
    maxTokens,
  })
  if (!fallback.error && fallback.content) {
    return { content: fallback.content, judgeName: `zen/${JUDGE_FALLBACK_MODEL}` }
  }
  throw new Error(`primary kimi-k3: ${lastPrimaryError}; fallback ${JUDGE_FALLBACK_MODEL}: ${fallback.error || 'empty content'}`)
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
  // Reasoning models (kimi-k3) burn reasoning tokens against max_tokens
  // before emitting content — 32/64 left content empty. 512 covers reasoning +
  // the tiny answer (a number or 3 Y/N lines).
  const maxTokens = 512

  try {
    const { content, judgeName } = await callJudgeModel(prompt, maxTokens)
    const score = config.binaryRubric ? parseBinaryRubricScore(content) : parseFreeFormScore(content)
    return {
      score,
      reasoning: content.trim().slice(0, 300),
      judgeName,
    }
  } catch (err) {
    // Total judge failure (primary + fallback) → -1 sentinel, excluded from median.
    return {
      score: -1,
      reasoning: `judge failed: ${err instanceof Error ? err.message : String(err)}`,
      judgeName: `${JUDGE_PRIMARY_MODEL}→${JUDGE_FALLBACK_MODEL}`,
    }
  }
}

// ==================== PUBLIC API ====================

/**
 * Score an actual answer against the expected answer using 3 judge slots
 * (kimi-k3 primary / space-bunny-free fallback — user directive 2026-11-30;
 * judge 3 uses a binary rubric). Returns the median + all raw scores.
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

  // Run the 3 judges sequentially (not Promise.all) — gentler on rate
  // limits: the eval runner already fires retrieval + generation before this,
  // and cases are paced 300ms apart. kimi-k3 còn chậm (~120s/call) nên tuần
  // tự cũng tránh dồn đòn 429 kéo dài phía NIM (đặc tính user nêu 2026-11-30).
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
