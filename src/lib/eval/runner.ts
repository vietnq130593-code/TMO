// Phase 4 SMOLAB Proposal 11' — Eval harness runner.
//
// Executes one EvalRun over the active EvalCase set:
//   Step 1 — retrieval via searchUserKB() (the REAL production retrieval path,
//            Qdrant chunks + Neo4j entities + memories + confidence score).
//   Step 2 — answer generation via the system-under-test model
//            (deepseek-ai/deepseek-v4-flash-0731 — a chat-core model that is
//            DIFFERENT from all judges; nemotron-550b is extraction-ONLY per
//            user directive 2026-08-25 and must not be used for eval answers).
//   Step 3 — scoring: recall@5 + entity extraction F1 + hallucination check +
//            faithfulness via 3 cross-family judges (judges.ts).
//
// Runs IN BACKGROUND (fire-and-forget from /api/eval/run POST) — NEVER
// synchronously in an HTTP request (100 cases × 4 LLM calls would timeout).
// Cases are paced 300ms apart to be gentle on NVIDIA rate limits.
//
// Per-case failures are recorded and skipped (a run only fails when the
// catastrophic path throws before aggregation). Progress is written to
// EvalRun.processedCount incrementally so the UI can poll live status.

import { db } from '@/lib/db'
import { callLLM } from '@/lib/llm'
import { searchUserKB } from '@/lib/kb-routing/kb-access'
import { judgeAnswer } from './judges'
// Task 20-c — auto-retrain calibration model sau eval run (fail-open)
import { trainCalibrationModel } from '@/lib/calibration-train'

/** System-under-test answer generator — a dedicated Agent/Chat core.
 *  MUST be different from all judge models (see judges.ts) to avoid circular
 *  bias. deepseek-v4-flash is the only chat core not used by any judge
 *  (judges: gpt-oss-120b + kimi-k3 + minimax-m3).
 *  User directive 2026-08-25: nemotron-3-ultra-550b is extraction-ONLY —
 *  it must NOT be used for eval answers or any non-extraction task.
 *  NOTE: deepseek-v4-flash is the slowest core (~27s/call) — eval runs take
 *  longer but run in background so it doesn't matter. */
const ANSWER_MODEL = 'deepseek-ai/deepseek-v4-flash-0731'

/** Pace-limit between cases (ms) — gentle on the shared 4-key NVIDIA budget. */
const CASE_PACE_MS = 300

/** Max chars of each retrieved chunk embedded into the answer prompt.
 *  Task 13B (2026-08-25): raised 500 → 2000. At 500 the answer model saw
 *  fragments too thin to ground an answer on — the Dijkstra case refused
 *  despite 5 healthy chunks (top-1 denseCos 0.55) because the truncated
 *  context didn't visibly discuss the question. Measured on this KB
 *  (500-point Qdrant sample): chunk content runs min 601 / median ~2055 /
 *  mean ~2100 / max ~2606 chars, so 2000 keeps ~95% of a typical chunk
 *  (vs ~25% at 500) and holds the top-5 context at ~10k chars — well within
 *  the answer model's context window. */
const CHUNK_PROMPT_TRUNCATE = 2000

/** Refusal markers — a negative case answer containing one of these is NOT a hallucination. */
const REFUSAL_MARKER_RE = /i don'?t know|không (biết|chắc)|no (information|data)|insufficient/i

/** Default number of cases per run when the caller doesn't specify. */
const DEFAULT_CASE_LIMIT = 10

/** Task 13E: system agent for eval retrieval — kb-access gates entity search
 *  + memory recall on agentId; without one the eval never exercised the
 *  (freshly backfilled) semantic entity layer. 'default' is the conventional
 *  system agent id used across the codebase. */
const EVAL_AGENT_ID = 'default'

interface ExpectedEntity {
  name: string
  type?: string
}

function parseExpectedEntities(json: string): ExpectedEntity[] {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e): e is ExpectedEntity => typeof e === 'object' && e !== null && typeof (e as ExpectedEntity).name === 'string')
      .map((e) => ({ name: e.name, type: typeof e.type === 'string' ? e.type : undefined }))
  } catch {
    return []
  }
}

/** Task 13E: normalize text for entity matching — curly quotes (U+2018/2019)
 *  and dashes from PDF extraction break exact substring matches against
 *  LLM-generated straight-quote expected entities. */
function normalizeForEntityMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
}

/**
 * Build the Step-2 answer prompt: question + top-5 retrieved chunks with scores.
 *
 * ML evaluation fix (Task 2, 2026-08-25): the old prompt's single
 * "if context is irrelevant, refuse" instruction made the answer model
 * refuse even when retrieval returned high-scoring, genuinely relevant
 * chunks (observed: Dijkstra query with 5 chunks at dense cosine ~0.31+
 * still refused). The prompt now grades the refusal decision explicitly:
 * strong evidence (chunks present + question overlaps chunk vocabulary)
 * → answer from context; weak/no evidence → refuse. Refusal remains the
 * correct behavior for empty context and for negative (out-of-domain)
 * eval cases.
 */
function buildAnswerPrompt(question: string, chunks: Array<{ text: string; score: number }>): string {
  const context =
    chunks.length === 0
      ? '(no context retrieved)'
      : chunks
          .slice(0, 5)
          .map((c, i) => `[${i + 1}] (score ${c.score.toFixed(3)}) ${c.text.slice(0, CHUNK_PROMPT_TRUNCATE)}`)
          .join('\n\n')
  const hasChunks = chunks.length > 0
  return (
    `Answer the question using the retrieved context below.\n\n` +
    `Decision rules (follow in order):\n` +
    `1. If the context is empty, or nothing in it relates to the question topic, say exactly: "I don't know based on the available knowledge base."\n` +
    (hasChunks
      ? `2. If one or more context chunks clearly discuss the question's topic — even partially — answer using those chunks. Cite what the chunks say; it is fine if the answer is incomplete. Do NOT refuse just because the coverage is partial. When the context contains passages on the topic, you MUST attempt an answer drawing only on those passages.\n`
      : `2. (n/a — context is empty)\n`) +
    `3. Never invent facts not present in the context. Partial, grounded answers are preferred over refusal when relevant evidence exists.\n\n` +
    `Question: ${question}\n\nContext:\n${context}`
  )
}

export interface RunEvalOptions {
  /** Max cases to process (default 10). */
  caseLimit?: number
  /** The EvalRun row id — must already exist (created by the API route). */
  runId: string
  /** Optional category filter (e.g. ['programming', 'negative']). */
  categories?: string[]
}

/**
 * Run an eval. Updates the EvalRun row incrementally (processedCount) and
 * finalizes aggregates + status when done. Never throws — catastrophic errors
 * mark the run 'failed' with errorMessage.
 */
export async function runEval(opts: RunEvalOptions): Promise<void> {
  const { runId } = opts
  const caseLimit = opts.caseLimit && opts.caseLimit > 0 ? opts.caseLimit : DEFAULT_CASE_LIMIT
  const categories = opts.categories && opts.categories.length > 0 ? opts.categories : undefined

  try {
    // Stratified case selection (round-robin across categories): with
    // caseLimit < total cases, a naive `orderBy createdAt asc, take N` grabs
    // whichever block was inserted first (negative cases, in our seed order) —
    // a 3-case run would then measure ONLY refusal behavior. Round-robin over
    // category buckets makes every small run representative of the mix.
    const allActive = await db.evalCase.findMany({
      where: {
        active: true,
        ...(categories ? { category: { in: categories } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, category: true },
    })

    // Bucket ids by category (preserving insertion order within each bucket).
    const buckets = new Map<string, string[]>()
    for (const c of allActive) {
      const list = buckets.get(c.category) ?? []
      list.push(c.id)
      buckets.set(c.category, list)
    }

    // Round-robin pick one case per category until the limit is reached.
    const selectedIds: string[] = []
    const bucketIterators = Array.from(buckets.values()).map((ids) => ({ ids, i: 0 }))
    while (selectedIds.length < caseLimit) {
      let pickedInRound = false
      for (const b of bucketIterators) {
        if (selectedIds.length >= caseLimit) break
        if (b.i < b.ids.length) {
          selectedIds.push(b.ids[b.i])
          b.i++
          pickedInRound = true
        }
      }
      if (!pickedInRound) break // all buckets exhausted
    }

    const cases = await db.evalCase.findMany({
      where: { id: { in: selectedIds } },
      orderBy: { createdAt: 'asc' },
    })

    if (cases.length === 0) {
      await db.evalRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          errorMessage: 'No active eval cases matched the filter',
          completedAt: new Date(),
        },
      })
      console.warn(`[EvalRunner] Run ${runId}: no active cases matched (limit=${caseLimit}, categories=${categories?.join(',') ?? 'all'})`)
      return
    }

    // Keep the run's caseCount truthful even if the selection changed since
    // the route created the row.
    await db.evalRun.update({ where: { id: runId }, data: { caseCount: cases.length } })

    console.log(`[EvalRunner] Run ${runId} started: ${cases.length} cases (limit=${caseLimit}, categories=${categories?.join(',') ?? 'all'}, answerModel=${ANSWER_MODEL})`)

    // Aggregates (computed in-memory, persisted once at the end).
    let sumRecall = 0
    let sumFaithfulness = 0
    let sumF1 = 0
    let sumLatency = 0
    let hallucinationCount = 0
    let processed = 0
    // Task 4: coverage + conditional faithfulness trackers.
    let answeredCount = 0
    let refusalCount = 0
    let sumAnsweredFaithfulness = 0

    for (const evalCase of cases) {
      const t0 = Date.now()
      const isNegativeCase = evalCase.category === 'negative'

      // ---- Step 1: retrieval (production path) ----
      let kb: { chunks: Array<{ text: string; score: number }>; confidence: number; rawConfidence?: number }
      try {
        // Task 13E: pass EVAL_AGENT_ID — searchUserKB gates entity search +
        // memory recall on agentId; without it every eval case measured a
        // KB with the (backfilled) semantic entity layer silently disabled.
        const result = await searchUserKB(evalCase.question, EVAL_AGENT_ID)
        kb = { chunks: result.chunks, confidence: result.confidence, rawConfidence: result.rawConfidence }
      } catch (err) {
        console.warn(`[EvalRunner] searchUserKB failed for case ${evalCase.id}: ${err instanceof Error ? err.message : String(err)}`)
        kb = { chunks: [], confidence: 0 }
      }

      // ---- Step 2: answer generation (system-under-test model) ----
      // One retry: nemotron-550b occasionally returns HTTP 503 (transient
      // rate-limit) — a second attempt usually lands on a healthy key.
      let answer = ''
      try {
        for (let attempt = 0; attempt < 2 && !answer; attempt++) {
          const genResult = await callLLM(buildAnswerPrompt(evalCase.question, kb.chunks), undefined, 'eval-answer', {
            model: ANSWER_MODEL,
            temperature: 0.3,
            maxTokens: 1024,
          })
          answer = genResult.content?.trim() || ''
          if (!answer && attempt === 0) {
            console.warn(`[EvalRunner] Answer generation failed for case ${evalCase.id} (${genResult.error ?? 'empty content'}) — retrying once`)
          }
        }
        if (!answer) {
          console.warn(`[EvalRunner] Answer generation failed for case ${evalCase.id} after retry`)
        }
      } catch (err) {
        console.warn(`[EvalRunner] Answer generation threw for case ${evalCase.id}: ${err instanceof Error ? err.message : String(err)}`)
      }

      // ---- Step 3: scoring ----
      const expectedEntities = parseExpectedEntities(evalCase.expectedEntities)

      // Entity hit in top-5 retrieved chunks (normalized substring — Task 13E:
      // PDF-extracted chunk text uses curly quotes/dashes that must be
      // normalized before matching straight-quote expected entities).
      const top5 = kb.chunks.slice(0, 5)
      const expectedEntitiesRetrieved = expectedEntities.filter((e) =>
        top5.some((c) => normalizeForEntityMatch(c.text).includes(normalizeForEntityMatch(e.name)))
      ).length

      // Entity hit in the generated answer (same normalization).
      const expectedEntitiesInAnswer = expectedEntities.filter((e) =>
        normalizeForEntityMatch(answer).includes(normalizeForEntityMatch(e.name))
      ).length

      // recall@5: fraction of expected entities retrieved in the top-5 chunks.
      const recallAt5 = expectedEntities.length > 0 ? expectedEntitiesRetrieved / expectedEntities.length : 0

      // Simplified same-set F1 (precision = recall = inAnswer/expectedCount).
      const extractionF1 =
        expectedEntities.length > 0
          ? expectedEntitiesInAnswer / expectedEntities.length
          : answer.trim().length > 0
            ? 1
            : 0

      // Negative case: hallucination = answer does NOT contain a refusal marker.
      const hallucinationDetected = isNegativeCase && !REFUSAL_MARKER_RE.test(answer)

      // Task 4 (2026-08-25): coverage — did the system ATTEMPT an answer?
      // answered = non-empty answer that is NOT a refusal. For negative cases
      // the semantics invert: refusal IS the correct "answer" → coverage = 1
      // when the system correctly refused.
      const isRefusal = REFUSAL_MARKER_RE.test(answer) || answer.trim().length === 0
      const answered = isNegativeCase ? isRefusal : !isRefusal
      const coverage = answered ? 1 : 0

      // Faithfulness via 3 cross-family judges (median is the robust aggregate).
      const verdict = await judgeAnswer(evalCase.question, evalCase.expectedAnswer, answer, isNegativeCase)

      const latencyMs = Date.now() - t0

      await db.evalResult.create({
        data: {
          runId,
          caseId: evalCase.id,
          answer: answer.slice(0, 8000),
          retrievedChunks: kb.chunks.length,
          expectedEntitiesInAnswer,
          expectedEntitiesRetrieved,
          recallAt5,
          faithfulnessMedian: verdict.median,
          faithfulnessScores: JSON.stringify(verdict.scores),
          extractionF1,
          hallucinationDetected,
          coverage,
          answered,
          rawConfidence: kb.rawConfidence ?? kb.confidence, // Prop 3.5 — calibration training X (20-c fix: giá trị TRƯỚC calibration, hết feedback-loop)
          latencyMs,
        },
      })
      processed++
      await db.evalRun.update({ where: { id: runId }, data: { processedCount: { increment: 1 } } })

      sumRecall += recallAt5
      sumFaithfulness += verdict.median
      sumF1 += extractionF1
      sumLatency += latencyMs
      if (hallucinationDetected) hallucinationCount++
      if (answered) {
        answeredCount++
        sumAnsweredFaithfulness += verdict.median
      } else {
        refusalCount++
      }

      console.log(
        `[EvalRunner] Case ${processed}/${cases.length} (${evalCase.category}): coverage=${answered ? 'ANSWERED' : 'refused'}, ` +
        `recall@5=${recallAt5.toFixed(2)}, ` +
        `faithfulness=${verdict.median.toFixed(2)} [${verdict.scores.map((s) => (s < 0 ? 'fail' : s.toFixed(2))).join(', ')}], ` +
        `f1=${extractionF1.toFixed(2)}, hallucination=${hallucinationDetected}, ${latencyMs}ms — "${evalCase.question.slice(0, 60)}"`
      )

      // Pace-limit — be gentle on the shared NVIDIA key budget.
      if (processed < cases.length) {
        await new Promise((r) => setTimeout(r, CASE_PACE_MS))
      }
    }

    await db.evalRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        processedCount: processed,
        avgRecallAt5: processed > 0 ? sumRecall / processed : 0,
        avgFaithfulness: processed > 0 ? sumFaithfulness / processed : 0,
        avgCoverage: processed > 0 ? answeredCount / processed : 0,
        avgCondFaithfulness: answeredCount > 0 ? sumAnsweredFaithfulness / answeredCount : 0,
        answeredCount,
        refusalCount,
        avgF1: processed > 0 ? sumF1 / processed : 0,
        avgLatencyMs: processed > 0 ? Math.round(sumLatency / processed) : 0,
        hallucinationCount,
      },
    })
    console.log(
      `[EvalRunner] Run ${runId} completed: ${processed} cases, coverage=${answeredCount}/${processed}, ` +
      `avgRecall@5=${(processed > 0 ? sumRecall / processed : 0).toFixed(3)}, ` +
      `avgFaithfulness=${(processed > 0 ? sumFaithfulness / processed : 0).toFixed(3)}, ` +
      `condFaithfulness(answered)=${(answeredCount > 0 ? sumAnsweredFaithfulness / answeredCount : 0).toFixed(3)}, ` +
      `avgF1=${(processed > 0 ? sumF1 / processed : 0).toFixed(3)}, ` +
      `hallucinations=${hallucinationCount}`
    )

    // Task 20-c — AUTO-RETRAIN calibration sau eval run hoàn tất: đủ ≥10
    // EvalResult usable là train lại CalibrationModel (fail-open tuyệt đối —
    // retrain fail KHÔNG được làm fail eval run đã completed).
    try {
      void trainCalibrationModel()
        .then(train => {
          if (train.trained) {
            console.log(`[EvalRunner] Auto-retrain calibration OK: intercept=${train.intercept.toFixed(4)}, coef=${train.coef.toFixed(4)}, sampleSize=${train.sampleSize} (kb-access áp khi sampleSize ≥ 20)`)
          } else {
            console.log(`[EvalRunner] Auto-retrain skipped: ${train.error} (usable=${train.usable}/${train.total})`)
          }
        })
        .catch(trainErr => {
          console.warn('[EvalRunner] Auto-retrain calibration failed (fail-open):', trainErr instanceof Error ? trainErr.message : String(trainErr))
        })
    } catch { /* fail-open */ }
  } catch (err) {
    // Catastrophic error — mark the run failed.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[EvalRunner] Run ${runId} FAILED:`, message)
    try {
      await db.evalRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          errorMessage: message.slice(0, 500),
          completedAt: new Date(),
        },
      })
    } catch (updateErr) {
      console.error(`[EvalRunner] Failed to mark run ${runId} as failed:`, updateErr instanceof Error ? updateErr.message : String(updateErr))
    }
  }
}
