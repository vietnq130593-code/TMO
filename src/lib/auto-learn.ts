/**
 * Auto-Learn Module — Phase 4
 *
 * When an Agent answers a query with low confidence (DB didn't have enough info),
 * the agent uses its own LLM knowledge + reasoning to answer.
 * Auto-Learn captures that knowledge and writes it back to the DB so future
 * queries can find it directly without re-asking the LLM.
 *
 * Flow:
 *   1. processQuery returns low confidence → auto-learn is triggered
 *   2. Extract entities/relationships from the answer (using LLM)
 *   3. Generate embedding for the answer (NVIDIA primary)
 *   4. Save to Qdrant as a new chunk (vector + text)
 *   5. Save entities/relationships to SQLite buffer (synced=false, will sync to Neo4j)
 *   6. Save AutoLearnRecord to SQLite (audit trail)
 *   7. Also save as AgentInsight for the agent's knowledge base
 *
 * All steps are NON-BLOCKING — the user gets their answer immediately,
 * auto-learn happens in the background.
 *
 * Confidence threshold: Only auto-learn when confidence >= 0.5 (answer is usable)
 *   but < 0.85 (answer came mostly from LLM, not from KB).
 *   If confidence >= 0.85 → KB already had enough info, no need to learn.
 *   If confidence < 0.5 → answer is too unreliable, don't learn garbage.
 */

import { generateEmbedding, getEmbeddingDimension, getCurrentEmbeddingModelVersion } from '@/lib/embeddings'
import { callLLM, addTokensUsedByAgent } from '@/lib/llm'
import { db } from '@/lib/db'
import { chunkText } from '@/lib/chunking'

// ==================== TYPES ====================

export interface AutoLearnInput {
  query: string
  answer: string
  confidence: number
  agentId: string
  agentName: string
  provider: string
  model: string
  /** Sources from the query result — used to understand what KB already had */
  sources?: Array<{ type: string; content: string; documentTitle?: string }>
}

interface ExtractedKnowledge {
  entities: Array<{
    name: string
    type: string
    description: string
  }>
  relationships: Array<{
    sourceName: string
    targetName: string
    type: string
    description: string
  }>
  keyFacts: string[]
}

// ==================== CONSTANTS ====================

/** Minimum confidence to trigger auto-learn (below this = too unreliable) */
const AUTO_LEARN_MIN_CONFIDENCE = 0.5

/** Maximum confidence to trigger auto-learn (above this = KB already had enough) */
const AUTO_LEARN_MAX_CONFIDENCE = 0.85

/** Maximum answer length to embed (avoid huge embeddings) */
const MAX_EMBEDDING_TEXT_LENGTH = 2000

/** Virtual document ID prefix for auto-learned knowledge */
const AUTO_LEARN_DOC_PREFIX = 'auto-learn'

// Phase 2 SMOLAB Proposal 4.4 — Cold-start + conservative thresholds.
// Read once at module load (cheap; env rarely changes during a session).
const COLD_START_INSIGHT_THRESHOLD = parseInt(process.env.COLD_START_INSIGHT_THRESHOLD || '100', 10)
const CONSERVATIVE_INSIGHT_THRESHOLD = parseInt(process.env.CONSERVATIVE_INSIGHT_THRESHOLD || '500', 10)
const CONSERVATIVE_CONFIDENCE_MIN = parseFloat(process.env.CONSERVATIVE_CONFIDENCE_MIN || '0.7')

/**
 * Phase 2 SMOLAB Proposal 4.4 — Cold-start gate.
 *
 * On a fresh install (KB nearly empty), auto-learn would otherwise fill the
 * KB with unverified LLM output in the first few hours because Pre-Phase 1
 * P0.2's "only learn when confidence HIGH" gate is satisfied whenever the
 * LLM is confidently wrong. Cold-start + conservative bands add an extra
 * population-based gate:
 *
 *   knowledgeCount <  COLD_START_INSIGHT_THRESHOLD (100)  → never learn
 *   knowledgeCount <  CONSERVATIVE_INSIGHT_THRESHOLD (500) → require confidence >= CONSERVATIVE_CONFIDENCE_MIN (0.7)
 *   otherwise                                              → fall through to P0.2 normal gate (≥ 0.85)
 *
 * ML evaluation fix (Task 3, 2026-08-25): the population metric now counts
 * INGESTED knowledge — Documents + LocalEntity + AgentInsight — not just
 * AgentInsight. Counting insights alone created a deadlock: insights come
 * from auto-learn, auto-learn needs 100 insights → the flywheel can never
 * start on a freshly-restored KB that has 17 documents + 1000 entities of
 * genuine human-curated seed knowledge. Ingested documents are actually a
 * STRONGER trust signal than insights (human-approved source material vs
 * LLM-generated). Entities are weighted 0.25 (they're derived from the
 * documents — counting them at 1.0 would double-count).
 *
 * Note: P0.2's gate (confidence >= 0.85) is the FINAL gate even after this
 * passes — this function only adds *extra* restrictions for low-population
 * regimes, it does NOT relax P0.2.
 *
 * Returns `{ allow: false, reason }` if cold-start/conservative bands reject,
 * `{ allow: true }` if caller should proceed to P0.2 gate.
 */
async function shouldAutoLearnConsideringColdStart(
  agentId: string,
  confidence: number
): Promise<{ allow: boolean; reason?: string }> {
  // Population check — 3 cheap COUNT queries, cached by SQLite page cache
  // after first call. Counts across ALL agents because cold-start is a
  // property of the entire KB, not per-agent.
  let knowledgeCount = 0
  try {
    const [docCount, entityCount, insightCount] = await Promise.all([
      db.document.count(),
      db.localEntity.count(),
      db.agentInsight.count(),
    ])
    // Documents count full (human-approved source material). Entities are
    // derived from documents → weight 0.25 to avoid double-counting. Insights
    // count full (manual teachings carry human trust; auto ones already
    // passed the 0.85 confidence gate when written).
    knowledgeCount = docCount + Math.floor(entityCount * 0.25) + insightCount
  } catch (err) {
    // DB error → fail-open (let P0.2 gate decide). Don't crash auto-learn
    // because of a transient DB issue; the population gate is best-effort.
    console.warn('[AutoLearn] Cold-start count failed, skipping population gate:', err instanceof Error ? err.message : String(err))
    return { allow: true }
  }

  if (knowledgeCount < COLD_START_INSIGHT_THRESHOLD) {
    return {
      allow: false,
      reason: `cold start (knowledgeCount=${knowledgeCount} < ${COLD_START_INSIGHT_THRESHOLD} — docs+entities*0.25+insights)`,
    }
  }

  if (knowledgeCount < CONSERVATIVE_INSIGHT_THRESHOLD) {
    if (confidence < CONSERVATIVE_CONFIDENCE_MIN) {
      return {
        allow: false,
        reason: `conservative band (knowledgeCount=${knowledgeCount} < ${CONSERVATIVE_INSIGHT_THRESHOLD}) requires confidence >= ${CONSERVATIVE_CONFIDENCE_MIN}, got ${confidence.toFixed(2)}`,
      }
    }
  }

  return { allow: true }
}

// ==================== MAIN FUNCTION ====================

/**
 * Auto-learn from an agent's answer.
 *
 * This function is designed to be called NON-BLOCKING (fire-and-forget).
 * It catches all errors internally and logs them.
 *
 * @returns true if learning was triggered, false if skipped
 */
export async function autoLearnFromAnswer(input: AutoLearnInput): Promise<boolean> {
  const startTime = Date.now()

  // Phase 2 SMOLAB Proposal 4.4 — Cold-start + conservative band check.
  // Cheap population-based gate BEFORE the P0.2 confidence gate. On fresh
  // install (< 100 insights) → never learn. Conservative band (100-499) →
  // require confidence >= 0.7. This is an ADDITIONAL restriction; does NOT
  // relax P0.2's gate below.
  const coldStart = await shouldAutoLearnConsideringColdStart(input.agentId, input.confidence)
  if (!coldStart.allow) {
    console.log(`[AutoLearn] Skipped: ${coldStart.reason}`)
    return false
  }

  // Phase 6 SMOLAB P0.2 — REVERSED auto-learn gate.
  // Old logic (reversed): learn when confidence in [0.5, 0.85) — the "unverified
  // middle band". This created a self-reinforcing hallucination loop because the
  // LLM output wasn't actually confirmed by KB retrieval.
  // New logic: ONLY learn when confidence is HIGH (>= MAX = 0.85) — meaning KB
  // strongly confirmed the answer is correct from existing knowledge, so it's
  // safe to memorize for future fast-path retrieval.
  // Below MAX = unverified LLM output → do NOT memorize (skip silently).
  if (input.confidence < AUTO_LEARN_MAX_CONFIDENCE) {
    console.log(`[AutoLearn] Skipped: confidence ${input.confidence.toFixed(2)} < ${AUTO_LEARN_MAX_CONFIDENCE} (KB did not strongly confirm — learning would memorize unverified LLM output)`)
    return false
  }

  console.log(`[AutoLearn] Starting for agent "${input.agentName}" (confidence: ${input.confidence.toFixed(2)}, query: "${input.query.slice(0, 60)}...")`)

  // Generate a virtual document ID for this auto-learn batch
  const documentId = `${AUTO_LEARN_DOC_PREFIX}-${Date.now()}-${input.agentId.slice(0, 8)}`
  let recordId: string | undefined

  try {
    // 2. Create AutoLearnRecord in SQLite (status: pending)
    const record = await db.autoLearnRecord.create({
      data: {
        agentId: input.agentId,
        agentName: input.agentName,
        query: input.query,
        answerPreview: input.answer.slice(0, 500),
        confidence: input.confidence,
        provider: input.provider,
        model: input.model,
        documentId,
        status: 'pending',
      },
    })
    recordId = record.id

    // 3. Extract entities/relationships from answer using LLM
    //    Pass agentId/agentName so extraction tokens are tracked per-agent
    const extraction = await extractKnowledgeFromAnswer(input.answer, input.query, input.agentId, input.agentName)

    // 4. Generate embedding for the answer (Phase 6 SMOLAB P0.3: use recursive chunker
    //    instead of naive slice(0, 2000). Long answers get split into multiple chunks
    //    → better recall (no semantic content lost beyond char 2000).
    //    If chunker returns multiple chunks, embed the first (semantic density highest).
    const chunks = chunkText(input.answer, 400, 50)
    const textToEmbed = chunks.length > 0 ? chunks[0].text : input.answer.slice(0, MAX_EMBEDDING_TEXT_LENGTH)
    const embResult = await generateEmbedding(textToEmbed)
    // Phase 6 SMOLAB P0.1: empty vector signal (all providers failed, no pseudo-hash)
    const chunkSaved = embResult.vector.length === getEmbeddingDimension()

    // 5. Save chunk to Qdrant (vector + text)
    let qdrantPointId: string | undefined
    if (chunkSaved) {
      qdrantPointId = await saveChunkToQdrant({
        documentId,
        content: input.answer,
        vector: embResult.vector,
        agentName: input.agentName,
        query: input.query,
        confidence: input.confidence,
        provider: input.provider,
        model: input.model,
      })
    }

    // 6. Save entities to SQLite buffer (will sync to Neo4j later)
    let entitiesSaved = 0
    for (const entity of extraction.entities) {
      try {
        await db.localEntity.create({
          data: {
            documentId,
            entityName: entity.name,
            entityType: entity.type,
            description: entity.description || null,
            confidenceScore: input.confidence,
            source: `auto-learn:${input.agentName}`,
            domain: 'auto-learned',
            synced: false,
          },
        })
        entitiesSaved++
      } catch (err) {
        console.warn(`[AutoLearn] Failed to save entity "${entity.name}":`, err instanceof Error ? err.message : String(err))
      }
    }

    // 7. Save relationships to SQLite buffer
    let relationshipsSaved = 0
    for (const rel of extraction.relationships) {
      try {
        await db.localRelationship.create({
          data: {
            documentId,
            sourceEntityName: rel.sourceName,
            targetEntityName: rel.targetName,
            relationshipType: rel.type,
            description: rel.description || null,
            confidenceScore: input.confidence,
            source: `auto-learn:${input.agentName}`,
            synced: false,
          },
        })
        relationshipsSaved++
      } catch (err) {
        console.warn(`[AutoLearn] Failed to save relationship "${rel.sourceName}-${rel.type}->${rel.targetName}":`, err instanceof Error ? err.message : String(err))
      }
    }

    // 8. Save as AgentInsight for the agent's knowledge base
    try {
      await db.agentInsight.create({
        data: {
          agentId: input.agentId,
          content: `Query: ${input.query}\n\nAnswer: ${input.answer.slice(0, 800)}`,
          source: 'auto',
          type: 'factual',
          confidence: input.confidence,
        },
      })
    } catch (err) {
      console.warn('[AutoLearn] Failed to save agent insight:', err instanceof Error ? err.message : String(err))
    }

    // 9. Log to LearningLog
    try {
      await db.learningLog.create({
        data: {
          agentId: input.agentId,
          eventType: 'insight',
          content: JSON.stringify({
            type: 'auto-learn',
            query: input.query,
            answerPreview: input.answer.slice(0, 200),
            confidence: input.confidence,
            entitiesCount: entitiesSaved,
            relationshipsCount: relationshipsSaved,
            chunkSaved,
            qdrantPointId,
            documentId,
          }),
        },
      })
    } catch (err) {
      console.warn('[AutoLearn] Failed to log learning event:', err instanceof Error ? err.message : String(err))
    }

    // 10. Update AutoLearnRecord → completed
    await db.autoLearnRecord.update({
      where: { id: recordId },
      data: {
        entitiesCount: entitiesSaved,
        relationshipsCount: relationshipsSaved,
        chunkSaved,
        neo4jSynced: false, // Will be synced by the pipeline later
        qdrantPointId,
        documentId,
        status: 'completed',
      },
    })

    const durationMs = Date.now() - startTime
    console.log(`[AutoLearn] Completed for "${input.agentName}": ${entitiesSaved} entities, ${relationshipsSaved} rels, chunk=${chunkSaved} (${durationMs}ms)`)

    return true
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error(`[AutoLearn] Failed for "${input.agentName}":`, errorMsg)

    // Update record → failed
    if (recordId) {
      try {
        await db.autoLearnRecord.update({
          where: { id: recordId },
          data: { status: 'failed', errorMessage: errorMsg.slice(0, 500) },
        })
      } catch {}
    }

    return false
  }
}

// ==================== KNOWLEDGE EXTRACTION ====================

/**
 * Extract entities, relationships, and key facts from an agent's answer.
 * Uses the same LLM infrastructure but with a focused extraction prompt.
 */
async function extractKnowledgeFromAnswer(
  answer: string,
  query: string,
  agentId?: string,
  agentName?: string
): Promise<ExtractedKnowledge> {
  const extractionPrompt = `You are a knowledge extraction system. Given a user query and an AI agent's answer, extract structured knowledge.

USER QUERY: ${query}

AGENT ANSWER:
${answer.slice(0, 3000)}

Extract the following in JSON format:
{
  "entities": [
    {"name": "Entity Name", "type": "Concept|Technology|Framework|Vulnerability|Principle|Domain|Document|Person", "description": "Brief description"}
  ],
  "relationships": [
    {"sourceName": "Entity A", "targetName": "Entity B", "type": "PART_OF|IMPLEMENTED_IN|USES|EXPLOITS|MITIGATES|RUNS_ON|DEPENDS_ON|CONTRASTS_WITH|ENABLES|CONTAINS|EXTENDS|APPLIES_TO|CREATED_BY|DOCUMENTED_IN|ALTERNATIVE_TO", "description": "Brief description"}
  ],
  "keyFacts": [
    "Fact 1 extracted from the answer",
    "Fact 2..."
  ]
}

ENTITY TYPES (with examples — choose the BEST match, never default to Concept):
- Concept: abstract idea OR step-by-step procedure — "Encapsulation", "Backpropagation", "Quick Sort", "TDD"
- Technology: tool/platform/runtime — "Docker", "Linux", "AWS", "Kubernetes"
- Framework: software framework/library — "Next.js", "Express", "React", "PyTorch"
- Vulnerability: security flaw — "SQL Injection", "XSS", "CSRF"
- Principle: rule/practice — "DRY", "SOLID", "Least Privilege"
- Domain: knowledge area — "Cybersecurity", "DevOps", "Machine Learning"
- Document: source PDF — "ML_Textbook.pdf", "Security_Report.pdf"
- Person: human author/creator — "Linus Torvalds", "Geoffrey Hinton"

RELATIONSHIP TYPES (with direction — source → target):
- PART_OF: A is component of B (Controller → MVC Pattern)
- IMPLEMENTED_IN: A built with B (React → JavaScript)
- USES: A uses B at runtime (Next.js → Webpack)
- EXPLOITS: A attacks B (Malware → SQL Injection)
- MITIGATES: A prevents B (Prepared Statements → SQL Injection)
- RUNS_ON: A executes on B (Docker → Linux)
- DEPENDS_ON: A requires B (App → Database)
- CONTRASTS_WITH: A opposed to B (SQL → NoSQL)
- ENABLES: A makes B possible (Containers → Microservices)
- CONTAINS: A includes B (Document → Entity)
- EXTENDS: A inherits from B (TypeScript → JavaScript)
- APPLIES_TO: A is relevant to B (GDPR → Web Apps)
- CREATED_BY: A made by person B (Linux → Linus Torvalds)
- DOCUMENTED_IN: A described in B (API → API_Docs.pdf)
- ALTERNATIVE_TO: A substitutes B (React ↔ Vue)

Rules:
- Only extract entities explicitly mentioned in the answer
- Entity types must be one of: Concept, Technology, Framework, Vulnerability, Principle, Domain, Document, Person
- Relationship types must be one of the listed types
- Keep descriptions concise (1-2 sentences max)
- Extract 1-5 entities, 0-3 relationships, 2-5 key facts
- If the answer doesn't contain extractable knowledge, return empty arrays
- Return ONLY the JSON, no markdown or explanation`

  try {
    const result = await callLLM(extractionPrompt, undefined, 'auto-learn-extraction', {
      temperature: 0.1,
      maxTokens: 2048,
      ...(agentId ? { agentId } : {}),
      ...(agentName ? { agentName } : {}),
    })

    // Track extraction tokens per-agent if agentId is available
    if (result.tokensUsed && result.tokensUsed > 0 && agentId) {
      addTokensUsedByAgent(
        result.tokensUsed,
        result.tokensUsed, // approximate — API doesn't always split input/output for extraction
        0,
        result.provider || 'unknown',
        result.model || 'auto-learn-extraction',
        agentId,
        agentName || 'unknown'
      )
    }

    if (!result.content) {
      return { entities: [], relationships: [], keyFacts: [] }
    }

    // Parse JSON from the response
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      console.warn('[AutoLearn] No JSON found in extraction response')
      return { entities: [], relationships: [], keyFacts: [] }
    }

    const parsed = JSON.parse(jsonMatch[0]) as ExtractedKnowledge

    // Validate and sanitize
    return {
      entities: Array.isArray(parsed.entities)
        ? parsed.entities
            .filter(e => e.name && e.type)
            .slice(0, 5)
            .map(e => ({
              name: String(e.name).slice(0, 200),
              type: String(e.type).slice(0, 50),
              description: String(e.description || '').slice(0, 500),
            }))
        : [],
      relationships: Array.isArray(parsed.relationships)
        ? parsed.relationships
            .filter(r => r.sourceName && r.targetName && r.type)
            .slice(0, 3)
            .map(r => ({
              sourceName: String(r.sourceName).slice(0, 200),
              targetName: String(r.targetName).slice(0, 200),
              type: String(r.type).slice(0, 50),
              description: String(r.description || '').slice(0, 500),
            }))
        : [],
      keyFacts: Array.isArray(parsed.keyFacts)
        ? parsed.keyFacts.slice(0, 5).map(f => String(f).slice(0, 300))
        : [],
    }
  } catch (err) {
    console.warn('[AutoLearn] Knowledge extraction failed:', err instanceof Error ? err.message : String(err))
    return { entities: [], relationships: [], keyFacts: [] }
  }
}

// ==================== QDRANT SAVE ====================

/**
 * Save auto-learned knowledge as a chunk in Qdrant.
 * This makes the knowledge searchable via vector search for future queries.
 */
async function saveChunkToQdrant(params: {
  documentId: string
  content: string
  vector: number[]
  agentName: string
  query: string
  confidence: number
  provider: string
  model: string
}): Promise<string | undefined> {
  try {
    const { upsertChunks } = await import('@/lib/qdrant')
    const pointId = `al-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Phase 3 SMOLAB Prop 4.1 — stamp the active embedding model version on the
    // chunk payload. Lazy-cached 5 min in embeddings.ts, so 1 DB query per batch
    // (not per chunk). Falls back to `${NVIDIA_EMBED_MODEL}@unknown` if no DB row.
    const embeddingModelVersion = await getCurrentEmbeddingModelVersion()

    const success = await upsertChunks([{
      id: pointId,
      vector: params.vector,
      payload: {
        document_id: params.documentId,
        chunk_index: 0,
        content: params.content.slice(0, 4000),
        heading_path: `Auto-Learn: ${params.agentName}`,
        token_count: Math.ceil(params.content.length / 4),
        domain: 'auto-learned',
        created_at: new Date().toISOString(),
        // Extra metadata for auto-learned chunks
        auto_learned: true,
        agent_name: params.agentName,
        original_query: params.query.slice(0, 500),
        confidence: params.confidence,
        llm_provider: params.provider,
        llm_model: params.model,
        embedding_model_version: embeddingModelVersion,
      },
    }])

    if (success) {
      console.log(`[AutoLearn] Chunk saved to Qdrant: ${pointId}`)
      return pointId
    } else {
      console.warn('[AutoLearn] Failed to save chunk to Qdrant')
      return undefined
    }
  } catch (err) {
    console.warn('[AutoLearn] Qdrant save error:', err instanceof Error ? err.message : String(err))
    return undefined
  }
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Get auto-learn statistics for the dashboard.
 */
export async function getAutoLearnStats(): Promise<{
  totalRecords: number
  completedRecords: number
  failedRecords: number
  pendingRecords: number
  totalEntities: number
  totalRelationships: number
  totalChunks: number
  recentRecords: Array<{
    id: string
    agentName: string
    query: string
    confidence: number
    entitiesCount: number
    relationshipsCount: number
    chunkSaved: boolean
    status: string
    createdAt: Date
  }>
}> {
  const [totalRecords, completedRecords, failedRecords, pendingRecords, recentRecords] = await Promise.all([
    db.autoLearnRecord.count(),
    db.autoLearnRecord.count({ where: { status: 'completed' } }),
    db.autoLearnRecord.count({ where: { status: 'failed' } }),
    db.autoLearnRecord.count({ where: { status: 'pending' } }),
    db.autoLearnRecord.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        agentName: true,
        query: true,
        confidence: true,
        entitiesCount: true,
        relationshipsCount: true,
        chunkSaved: true,
        status: true,
        createdAt: true,
      },
    }),
  ])

  const completedData = await db.autoLearnRecord.findMany({
    where: { status: 'completed' },
    select: { entitiesCount: true, relationshipsCount: true, chunkSaved: true },
  })

  return {
    totalRecords,
    completedRecords,
    failedRecords,
    pendingRecords,
    totalEntities: completedData.reduce((sum, r) => sum + r.entitiesCount, 0),
    totalRelationships: completedData.reduce((sum, r) => sum + r.relationshipsCount, 0),
    totalChunks: completedData.filter(r => r.chunkSaved).length,
    recentRecords,
  }
}

/**
 * Check if auto-learn should be triggered for a given query result.
 * This is the gate-keeper function that the chat route calls.
 *
 * Phase 6 SMOLAB P0.2 — gate logic REVERSED. Now only learns when
 * confidence >= AUTO_LEARN_MAX_CONFIDENCE (KB strongly confirmed answer).
 * Below that = unverified LLM output → skip to avoid hallucination loop.
 */
export function shouldAutoLearn(confidence: number, hasAgent: boolean): boolean {
  // Only auto-learn when:
  // 1. There's an agent (no auto-learn for anonymous/gateway requests)
  // 2. Confidence is HIGH enough that KB strongly confirmed the answer (P0.2 reversed gate)
  return hasAgent && confidence >= AUTO_LEARN_MAX_CONFIDENCE
}
