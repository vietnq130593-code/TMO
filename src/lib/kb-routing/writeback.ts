/**
 * Smart KB Routing — Layer 3: Writeback (Auto-Learning Loop)
 *
 * When Step 2 (Model Knowledge) provides information that Step 1 (User KB) lacked,
 * extract entities/relationships from the answer and write them back to:
 *   1. Qdrant (theopus_chunks — as new vector chunks)
 *   2. Neo4j (graph nodes + edges)
 *   3. AgentMemory (episodic memory)
 *
 * Writeback policy: ONLY writeback when extracted entity confidence > 0.5
 * (user-approved option c — filters out LLM hallucinations).
 *
 * Phase 4 of design doc.
 */

import { db } from '@/lib/db'
import { qdrant, COLLECTION_CHUNKS } from '@/lib/qdrant'
import { upsertChunks } from '@/lib/qdrant'
import { upsertEntitiesBatch, upsertRelationshipsBatch, type EntityNode, type RelationshipEdge } from '@/lib/neo4j'
import { storeMemory } from '@/lib/agent-memory'
import { generateEmbedding } from '@/lib/embeddings'
import { callLLM } from '@/lib/llm'
import type { UserKBResult, ModelKnowledgeResult } from './kb-access'

// ==================== CONFIG ====================

/**
 * Writeback confidence threshold — only extract + write entities/relationships
 * that the LLM marks with confidence > this value.
 * User-approved value: 0.5 (option c — filters hallucinations).
 */
export const WRITEBACK_CONFIDENCE_THRESHOLD = 0.5

/**
 * Maximum entities to writeback per query (safety cap to avoid KB bloat).
 */
const MAX_WRITEBACK_ENTITIES = 10
const MAX_WRITEBACK_RELATIONSHIPS = 15

// ==================== TYPES ====================

interface ExtractedEntityWithConfidence {
  name: string
  type: string
  description: string
  confidence: number  // 0-1 — LLM's confidence this is a real entity
  source: string  // 'model-knowledge'
}

interface ExtractedRelationshipWithConfidence {
  source: string
  target: string
  type: string
  description: string
  confidence: number  // 0-1 — LLM's confidence this relationship is real
}

export interface WritebackResult {
  skipped: boolean
  reason?: string
  entitiesWritten: number
  relationshipsWritten: number
  chunksWritten: number
  memoryStored: boolean
}

// ==================== EXTRACTION PROMPT ====================

const WRITEBACK_EXTRACTION_PROMPT = `You are a knowledge extraction system. Analyze the following LLM answer and extract entities + relationships that should be written back to the knowledge base.

ANSWER TO ANALYZE:
{answer}

CONTEXT (what the user KB already had — DO NOT re-extract these):
{context}

Extract in JSON format:
{
  "entities": [
    {
      "name": "Entity Name",
      "type": "Concept|Technology|Framework|Vulnerability|Principle|Domain|Document|Person",
      "description": "Brief description (1-2 sentences)",
      "confidence": 0.0-1.0
    }
  ],
  "relationships": [
    {
      "source": "Entity A name",
      "target": "Entity B name",
      "type": "PART_OF|IMPLEMENTED_IN|USES|EXPLOITS|MITIGATES|RUNS_ON|DEPENDS_ON|CONTRASTS_WITH|ENABLES|CONTAINS|EXTENDS|APPLIES_TO|CREATED_BY|DOCUMENTED_IN|ALTERNATIVE_TO",
      "description": "Brief description",
      "confidence": 0.0-1.0
    }
  ]
}

ENTITY TYPES (with examples):
- Concept: abstract idea OR algorithm/technique — "Encapsulation", "Quick Sort", "TDD"
- Technology: tool/platform/runtime — "Docker", "Linux", "AWS"
- Framework: software framework/library — "Next.js", "React", "PyTorch"
- Vulnerability: security flaw — "SQL Injection", "XSS"
- Principle: rule/practice — "DRY", "SOLID"
- Domain: knowledge area — "Cybersecurity", "DevOps"
- Document: source PDF
- Person: human author/creator — "Linus Torvalds"

RULES:
1. ONLY extract entities/relationships that are NEW (not already in the context above)
2. Confidence: 0.9+ = explicitly stated as fact, 0.7-0.9 = strongly implied, 0.5-0.7 = inferred, <0.5 = speculation
3. DO NOT extract speculative or uncertain information (confidence < 0.5)
4. Extract at most 10 entities + 15 relationships (most important first)
5. Return ONLY valid JSON, no markdown, no explanation`

// ==================== MAIN ENTRY ====================

/**
 * Decide whether to writeback, extract knowledge from Step 2 answer,
 * and write to all 3 KB stores (Qdrant + Neo4j + AgentMemory).
 *
 * Writeback policy (user-approved option c):
 *   - Skip if Step 2 was not invoked
 *   - Skip if no entities extracted
 *   - Filter: only write entities/relationships with confidence > 0.5
 */
export async function writebackToKB(params: {
  query: string
  step2Result: ModelKnowledgeResult
  step1Result: UserKBResult
  agentId?: string
  agentName?: string
  sessionId?: string
}): Promise<WritebackResult> {
  const { query, step2Result, step1Result, agentId, agentName, sessionId } = params

  // Gate 1: Step 2 must have been invoked
  if (!step2Result.used || !step2Result.content.trim()) {
    return {
      skipped: true,
      reason: 'Step 2 not invoked or empty answer',
      entitiesWritten: 0,
      relationshipsWritten: 0,
      chunksWritten: 0,
      memoryStored: false,
    }
  }

  // Gate 2: Step 2 must have supplemented Step 1
  if (!step2Result.supplemented) {
    return {
      skipped: true,
      reason: 'Step 2 did not supplement Step 1',
      entitiesWritten: 0,
      relationshipsWritten: 0,
      chunksWritten: 0,
      memoryStored: false,
    }
  }

  console.log(`[Writeback] Step 2 supplemented Step 1 — extracting new knowledge for writeback`)

  // Extract entities/relationships with confidence scores
  const extracted = await extractWithConfidence(step2Result.content, step1Result)

  if (!extracted) {
    return {
      skipped: true,
      reason: 'Extraction failed or returned nothing',
      entitiesWritten: 0,
      relationshipsWritten: 0,
      chunksWritten: 0,
      memoryStored: false,
    }
  }

  // Filter: only keep entities/relationships with confidence > threshold
  const filteredEntities = extracted.entities
    .filter(e => e.confidence > WRITEBACK_CONFIDENCE_THRESHOLD)
    .slice(0, MAX_WRITEBACK_ENTITIES)

  const filteredRelationships = extracted.relationships
    .filter(r => r.confidence > WRITEBACK_CONFIDENCE_THRESHOLD)
    .slice(0, MAX_WRITEBACK_RELATIONSHIPS)

  console.log(`[Writeback] Extracted: ${extracted.entities.length} entities, ${extracted.relationships.length} relationships. After filter (> ${WRITEBACK_CONFIDENCE_THRESHOLD}): ${filteredEntities.length} entities, ${filteredRelationships.length} relationships`)

  if (filteredEntities.length === 0 && filteredRelationships.length === 0) {
    return {
      skipped: true,
      reason: `No entities/relationships passed confidence threshold ${WRITEBACK_CONFIDENCE_THRESHOLD}`,
      entitiesWritten: 0,
      relationshipsWritten: 0,
      chunksWritten: 0,
      memoryStored: false,
    }
  }

  // Generate synthetic document ID for this writeback batch
  const documentId = `auto-learn:${Date.now()}`
  const now = new Date().toISOString()

  let entitiesWritten = 0
  let relationshipsWritten = 0
  let chunksWritten = 0
  let memoryStored = false

  // === WRITE 1: Qdrant chunks (embed entity descriptions) ===
  if (filteredEntities.length > 0) {
    try {
      const chunksToWrite = filteredEntities.map(e => {
        const text = `${e.name} (${e.type}): ${e.description}`
        // We'll embed these in parallel — but upsertChunks expects pre-computed vectors
        // So we'll embed here
        return { id: '', vector: [] as number[], payload: { text, documentId, source: 'auto-learn', entityName: e.name, entityType: e.type, confidence: e.confidence } }
      })

      // Generate embeddings for all chunks
      const embeddedChunks = await Promise.all(
        chunksToWrite.map(async (c, i) => {
          const { vector } = await generateEmbedding(c.payload.text)
          return {
            id: crypto.randomUUID(),
            vector,
            payload: c.payload,
          }
        })
      )

      const success = await upsertChunks(embeddedChunks)
      if (success) {
        chunksWritten = embeddedChunks.length
        console.log(`[Writeback] Wrote ${chunksWritten} chunks to Qdrant`)
      }
    } catch (err) {
      console.warn('[Writeback] Qdrant write failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // === WRITE 2: Neo4j entities + relationships ===
  if (filteredEntities.length > 0) {
    try {
      const entityNodes: EntityNode[] = filteredEntities.map((e, i) => ({
        id: `auto-learn-${Date.now()}-${i}`,
        name: e.name,
        entity_type: e.type as EntityNode['entity_type'],
        domain: 'mixed',
        description: e.description,
        confidence: e.confidence,  // Lower confidence for auto-learned
        documentId,
        source: 'auto-learn',
        chunk_id: '',
        created_at: now,
        updated_at: now,
      }))

      await upsertEntitiesBatch(entityNodes)
      entitiesWritten = entityNodes.length
      console.log(`[Writeback] Wrote ${entitiesWritten} entities to Neo4j`)
    } catch (err) {
      console.warn('[Writeback] Neo4j entity write failed:', err instanceof Error ? err.message : String(err))
    }
  }

  if (filteredRelationships.length > 0) {
    try {
      // Build edge payloads — note: sourceId/targetId must match existing entity IDs
      // For writeback, we link by entity name (Neo4j MERGE on name)
      const edges: RelationshipEdge[] = filteredRelationships.map((r, i) => ({
        sourceId: `auto-learn-by-name:${r.source}`,
        targetId: `auto-learn-by-name:${r.target}`,
        relationship_type: r.type,
        description: r.description,
        confidence: r.confidence,
        documentId,
        source: 'auto-learn',
        created_at: now,
      }))

      await upsertRelationshipsBatch(edges)
      relationshipsWritten = edges.length
      console.log(`[Writeback] Wrote ${relationshipsWritten} relationships to Neo4j`)
    } catch (err) {
      console.warn('[Writeback] Neo4j relationship write failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // === WRITE 3: AgentMemory (episodic) ===
  if (agentId && step2Result.content) {
    try {
      await storeMemory({
        agentId,
        agentName: agentName || 'unknown',
        sessionId,
        category: 'insight',
        content: `[Auto-learned from model knowledge] ${step2Result.content.slice(0, 500)}`,
        context: query,
        importance: 0.5,  // Medium — auto-learned, not user-confirmed
        source: 'auto-learn',
        tags: ['writeback', 'model-knowledge'],
      })
      memoryStored = true
      console.log(`[Writeback] Stored AgentMemory`)
    } catch (err) {
      console.warn('[Writeback] AgentMemory write failed:', err instanceof Error ? err.message : String(err))
    }
  }

  // === WRITE 4: AgentInsight + LearningLog (Learning tab visibility) ===
  // FIX (empty Learning tab): writeback replaced autoLearnFromAnswer, but nothing
  // wrote to AgentInsight/LearningLog anymore — the Learning tab timeline only
  // got data from manual teaching and 👍/👎 feedback. Record each successful
  // writeback as an insight + log so the Learning timeline reflects real chat
  // activity. Two cheap SQLite writes — NO extra LLM call.
  if (filteredEntities.length > 0 || filteredRelationships.length > 0) {
    try {
      const insightContent = `[KB writeback] ${filteredEntities.length} entities, ${filteredRelationships.length} relationships — query: "${query.slice(0, 120)}"`
      await db.agentInsight.create({
        data: {
          agentId: agentId || 'default',
          content: insightContent,
          source: 'auto',
          type: 'factual',
          confidence: 0.6,
        },
      })
      await db.learningLog.create({
        data: {
          agentId: agentId || 'default',
          sessionId: sessionId || null,
          eventType: 'pattern',
          content: JSON.stringify({
            kind: 'kb-writeback',
            entitiesWritten: filteredEntities.length,
            relationshipsWritten: filteredRelationships.length,
            chunksWritten,
            query: query.slice(0, 300),
            agentName: agentName || 'unknown',
          }),
          metadata: JSON.stringify({ source: 'writeback' }),
        },
      })
      console.log(`[Writeback] Recorded AgentInsight + LearningLog (Learning tab)`)
    } catch (err) {
      console.warn('[Writeback] Learning record failed:', err instanceof Error ? err.message : String(err))
    }
  }

  return {
    skipped: false,
    entitiesWritten,
    relationshipsWritten,
    chunksWritten,
    memoryStored,
  }
}

// ==================== LLM EXTRACTION WITH CONFIDENCE ====================

async function extractWithConfidence(
  answer: string,
  step1Result: UserKBResult
): Promise<{ entities: ExtractedEntityWithConfidence[]; relationships: ExtractedRelationshipWithConfidence[] } | null> {
  // Build context summary so LLM doesn't re-extract what we already have
  const contextSummary = [
    step1Result.chunks.length > 0 ? `${step1Result.chunks.length} chunks: ${step1Result.chunks.map(c => c.text.slice(0, 100)).join(' | ')}` : '(no chunks)',
    step1Result.entities.length > 0 ? `${step1Result.entities.length} entities: ${step1Result.entities.map(e => e.name).join(', ')}` : '(no entities)',
  ].join('\n')

  const prompt = WRITEBACK_EXTRACTION_PROMPT
    .replace('{answer}', answer.slice(0, 3000))
    .replace('{context}', contextSummary.slice(0, 1000))

  try {
    const result = await callLLM(prompt, undefined, 'writeback-extraction', {
      temperature: 0.1,
      maxTokens: 2000,
    })

    if (!result.content) return null

    // Try multiple extraction strategies — LLMs sometimes return malformed JSON
    let parsed: any = null
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0])
      } catch {
        // Try fixing common JSON issues (trailing commas, missing brackets)
        try {
          const cleaned = jsonMatch[0]
            .replace(/,\s*}/g, '}')   // trailing comma in object
            .replace(/,\s*\]/g, ']')  // trailing comma in array
          parsed = JSON.parse(cleaned)
        } catch {
          // Last resort: try to extract just the entities array
          const entMatch = result.content.match(/"entities"\s*:\s*\[([\s\S]*?)\]/)
          const relMatch = result.content.match(/"relationships"\s*:\s*\[([\s\S]*?)\]/)
          if (entMatch) {
            try {
              parsed = { entities: JSON.parse(`[${entMatch[1]}]`), relationships: [] }
            } catch {
              console.warn('[Writeback] Could not parse LLM JSON response')
              return null
            }
          }
        }
      }
    }
    if (!parsed) return null

    const entities: ExtractedEntityWithConfidence[] = (Array.isArray(parsed.entities) ? parsed.entities : [])
      .filter((e: any) => e?.name && typeof e.name === 'string')
      .map((e: any) => ({
        name: String(e.name).trim(),
        type: String(e.type || 'Concept').trim(),
        description: String(e.description || '').trim(),
        confidence: Math.min(1, Math.max(0, Number(e.confidence) || 0)),
        source: 'model-knowledge',
      }))

    const relationships: ExtractedRelationshipWithConfidence[] = (Array.isArray(parsed.relationships) ? parsed.relationships : [])
      .filter((r: any) => r?.source && r?.target)
      .map((r: any) => ({
        source: String(r.source).trim(),
        target: String(r.target).trim(),
        type: String(r.type || 'RELATED_TO').trim(),
        description: String(r.description || '').trim(),
        confidence: Math.min(1, Math.max(0, Number(r.confidence) || 0)),
      }))

    return { entities, relationships }
  } catch (err) {
    console.warn('[Writeback] Extraction LLM call failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}
