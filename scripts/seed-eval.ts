/**
 * Phase 4 SMOLAB Proposal 11' — Seed eval cases.
 *
 * Seeds the EvalCase table with a mix of:
 *   - 30 LLM-generated cases (6 per category: programming/algorithm/ml/security/linux)
 *   - up to 20 human-curated (from AgentInsight source='manual' with Query/Answer format)
 *   - 10 hardcoded negative out-of-domain cases (expected answer = refusal)
 *
 * Idempotent: skips insert when a case with the same question already exists.
 *
 * Usage: cd /home/z/tmo-app && set -a && source .env && set +a && bunx tsx scripts/seed-eval.ts
 */

import { db } from '../src/lib/db'
import { callLLM } from '../src/lib/llm'

const NEGATIVE_CASES = [
  'What is the capital of Mars?',
  'What color is the number seven?',
  'Who won the 2087 FIFA World Cup?',
  'What is the phone number of the president of the Moon?',
  'How many legs does a thunderstorm have?',
  'What is the boiling point of sadness?',
  'Who was the first human to walk on Europa?',
  'What language do dolphins code in?',
  'What is the GDP of Atlantis?',
  'What is the recipe for invisible soup?',
]

const CATEGORIES = ['programming', 'algorithm', 'ml', 'security', 'linux'] as const

async function main() {
  console.log('[SeedEval] Starting...')

  // ---- 1. LLM-generated cases (6 per category) ----
  const genPrompt = `Generate 6 diverse, specific, non-trivial evaluation questions for a knowledge-base QA system, all in the category "${'{category}'}".

For each question provide: question, expectedAnswer (2-4 sentences of factual answer), expectedEntities (1-3 JSON array of {name, type} where type is one of Concept|Technology|Framework|Vulnerability|Principle|Domain|Document|Person), difficulty (easy|medium|hard — mix them).

Return ONLY a JSON array of 6 objects like:
[{"question":"...","expectedAnswer":"...","expectedEntities":[{"name":"...","type":"Concept"}],"difficulty":"medium"}]`

  let llmInserted = 0
  for (const category of CATEGORIES) {
    try {
      const res = await callLLM(genPrompt.replace('{category}', category), undefined, 'eval-seed', {
        temperature: 0.7,
        maxTokens: 2500,
      })
      const jsonMatch = res.content?.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        console.warn(`[SeedEval] No JSON for category ${category} — skipping`)
        continue
      }
      const cases = JSON.parse(jsonMatch[0]) as Array<{
        question?: string
        expectedAnswer?: string
        expectedEntities?: Array<{ name?: string; type?: string }>
        difficulty?: string
      }>
      for (const c of cases) {
        if (!c.question || !c.expectedAnswer) continue
        const existing = await db.evalCase.findFirst({ where: { question: c.question } })
        if (existing) continue
        await db.evalCase.create({
          data: {
            question: String(c.question).slice(0, 1000),
            expectedAnswer: String(c.expectedAnswer).slice(0, 4000),
            expectedEntities: JSON.stringify(
              Array.isArray(c.expectedEntities)
                ? c.expectedEntities
                    .filter(e => e?.name)
                    .map(e => ({ name: String(e.name).slice(0, 200), type: String(e.type || 'Concept').slice(0, 50) }))
                    .slice(0, 3)
                : []
            ),
            category,
            difficulty: ['easy', 'medium', 'hard'].includes(String(c.difficulty)) ? String(c.difficulty) : 'medium',
            source: 'llm_generated',
          },
        })
        llmInserted++
      }
      console.log(`[SeedEval] ${category}: inserted ${cases.length} cases`)
    } catch (err) {
      console.warn(`[SeedEval] Category ${category} failed:`, err instanceof Error ? err.message : String(err))
    }
  }

  // ---- 2. Human-curated (from manual AgentInsights with Query/Answer format) ----
  let humanInserted = 0
  try {
    const insights = await db.agentInsight.findMany({
      where: { source: 'manual' },
      take: 50,
    })
    for (const insight of insights) {
      const qMatch = insight.content.match(/Query:\s*(.+)/i)
      const aMatch = insight.content.match(/Answer:\s*([\s\S]+)/i)
      if (!qMatch || !aMatch) continue
      const question = qMatch[1].trim().slice(0, 1000)
      if (!question) continue
      const existing = await db.evalCase.findFirst({ where: { question } })
      if (existing) continue
      await db.evalCase.create({
        data: {
          question,
          expectedAnswer: aMatch[1].trim().slice(0, 4000),
          expectedEntities: '[]',
          category: 'mixed',
          difficulty: 'medium',
          source: 'human_curated',
        },
      })
      humanInserted++
    }
    console.log(`[SeedEval] human_curated: inserted ${humanInserted} cases (from ${insights.length} manual insights)`)
  } catch (err) {
    console.warn('[SeedEval] Human-curated failed:', err instanceof Error ? err.message : String(err))
  }

  // ---- 3. Negative cases ----
  let negInserted = 0
  for (const question of NEGATIVE_CASES) {
    const existing = await db.evalCase.findFirst({ where: { question } })
    if (existing) continue
    await db.evalCase.create({
      data: {
        question,
        expectedAnswer: "I don't know based on the available knowledge base.",
        expectedEntities: '[]',
        category: 'negative',
        difficulty: 'easy',
        source: 'negative',
      },
    })
    negInserted++
  }
  console.log(`[SeedEval] negative: inserted ${negInserted} cases`)

  const total = await db.evalCase.count()
  const bySource = await db.evalCase.groupBy({ by: ['source'], _count: true })
  console.log(`[SeedEval] DONE. Total: ${total} cases | by source:`, bySource.map(g => `${g.source}=${g._count}`).join(', '))
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[SeedEval] FAILED:', err)
    process.exit(1)
  })
