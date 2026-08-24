// Phase 4 SMOLAB Proposal 11' — Eval harness runner.
//
// Executes one EvalRun over the active EvalCase set:
//   Step 1 — retrieval via searchUserKB() (the REAL production retrieval path,
//            Qdrant chunks + Neo4j entities + memories + confidence score).
//   Step 2 — answer generation via the system-under-test model
//            (nvidia/nemotron-3-ultra-550b-a55b — DIFFERENT from all judges).
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

/** System-under-test answer generator — the app's main extraction model.
 *  MUST be different from all judge models (see judges.ts) to avoid circular bias. */
const ANSWER_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b'

/** Pace-limit between cases (ms) — gentle on the shared 4-key NVIDIA budget. */
const CASE_PACE_MS = 300

/** Max chars of each retrieved chunk embedded into the answer prompt. */
const CHUNK_PROMPT_TRUNCATE = 500

/** Refusal markers — a negative case answer containing one of these is NOT a hallucination. */
const REFUSAL_MARKER_RE = /i don'?t know|không (biết|chắc)|no (information|data)|insufficient/i

/** Default number of cases per run when the caller doesn't specify. */
const DEFAULT_CASE_LIMIT = 10

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

/** Build the Step-2 answer prompt: question + top-5 retrieved chunks with scores. */
function buildAnswerPrompt(question: string, chunks: Array<{ text: string; score: number }>): string {
  const context =
    chunks.length === 0
      ? '(no context retrieved)'
      : chunks
          .slice(0, 5)
          .map((c, i) => `[${i + 1}] (score ${c.score.toFixed(3)}) ${c.text.slice(0, CHUNK_PROMPT_TRUNCATE)}`)
          .join('\n\n')
  return (
    `Answer the question using the retrieved context. If context is empty or irrelevant, say "I don't know based on the available knowledge base." ` +
    `Do not invent facts that are not supported by the context.\n\n` +
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

    for (const evalCase of cases) {
      const t0 = Date.now()
      const isNegativeCase = evalCase.category === 'negative'

      // ---- Step 1: retrieval (production path) ----
      let kb: { chunks: Array<{ text: string; score: number }>; confidence: number }
      try {
        const result = await searchUserKB(evalCase.question)
        kb = { chunks: result.chunks, confidence: result.confidence }
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
      const answerLower = answer.toLowerCase()

      // Entity hit in top-5 retrieved chunks (case-insensitive substring).
      const top5 = kb.chunks.slice(0, 5)
      const expectedEntitiesRetrieved = expectedEntities.filter((e) =>
        top5.some((c) => c.text.toLowerCase().includes(e.name.toLowerCase()))
      ).length

      // Entity hit in the generated answer.
      const expectedEntitiesInAnswer = expectedEntities.filter((e) =>
        answerLower.includes(e.name.toLowerCase())
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
          rawConfidence: kb.confidence, // Prop 3.5 — calibration training X
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

      console.log(
        `[EvalRunner] Case ${processed}/${cases.length} (${evalCase.category}): recall@5=${recallAt5.toFixed(2)}, ` +
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
        avgF1: processed > 0 ? sumF1 / processed : 0,
        avgLatencyMs: processed > 0 ? Math.round(sumLatency / processed) : 0,
        hallucinationCount,
      },
    })
    console.log(
      `[EvalRunner] Run ${runId} completed: ${processed} cases, avgRecall@5=${(processed > 0 ? sumRecall / processed : 0).toFixed(3)}, ` +
      `avgFaithfulness=${(processed > 0 ? sumFaithfulness / processed : 0).toFixed(3)}, avgF1=${(processed > 0 ? sumF1 / processed : 0).toFixed(3)}, ` +
      `hallucinations=${hallucinationCount}`
    )
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
