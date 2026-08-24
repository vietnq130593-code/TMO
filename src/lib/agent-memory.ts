/**
 * Agent Memory Module — Episodic Memory for AI Agents
 *
 * Architecture:
 *   SQLite (AgentMemory, UserProfile, MemoryAccessLog, ChatMessage) — structured metadata + relations
 *   Qdrant (agent_memory collection) — vector search for semantic recall
 *   NVIDIA NIM embeddings — 2048-dim vectors (same dimension as theopus_chunks)
 *
 * Memory Lifecycle:
 *   1. Store: User/assistant exchange → extractMemoriesFromConversation() → storeMemory()
 *   2. Recall: Query → generateQueryEmbedding() → searchSimilar() → recallMemories()
 *   3. Decay: decayMemories() reduces importance over time, deactivates stale memories
 *   4. Profile: UserProfile tracks long-term facts about the user
 *
 * Qdrant Collection: agent_memory (SEPARATE from theopus_chunks)
 *   - Stores episodic memories as vectors with payload
 *   - Supports semantic search via cosine similarity
 *   - Each point corresponds to one AgentMemory record
 */

import { db } from '@/lib/db'
import { qdrant } from '@/lib/qdrant'
import { generateEmbedding, generateQueryEmbedding, getEmbeddingDimension, generateEmbeddingBatch } from '@/lib/embeddings'
import { callLLM } from '@/lib/llm'

// ==================== CONSTANTS ====================

const COLLECTION_AGENT_MEMORY = 'agent_memory'

/** Default decay rate per day — 2% importance reduction for unused memories */
const DEFAULT_DECAY_RATE = 0.02

/** Minimum importance threshold — below this, memories are deactivated */
const DEACTIVATION_THRESHOLD = 0.1

/** Default top-K for recall */
const DEFAULT_TOP_K = 10

/** Default minimum score for Qdrant search */
const DEFAULT_MIN_SCORE = 0.3

// ==================== TYPES ====================

export interface RecallParams {
  agentId: string
  query: string
  topK?: number
  category?: string
  minImportance?: number
  sessionId?: string
}

export interface RecalledMemory {
  id: string
  content: string
  category: string
  importance: number
  relevance: number
  context: string | null
}

export interface StoreMemoryParams {
  agentId: string
  agentName: string
  sessionId?: string
  category: 'insight' | 'fact' | 'preference' | 'correction' | 'procedure' | 'user_info'
  content: string
  context?: string
  importance?: number
  source?: string
  tags?: string[]
}

export interface StoreMemoryResult {
  id: string
  qdrantPointId: string
}

export interface ExtractMemoriesParams {
  agentId: string
  agentName: string
  sessionId: string
  userMessage: string
  assistantMessage: string
}

export interface ExtractMemoriesResult {
  memoriesCreated: number
  userProfileUpdates: number
}

export interface DecayResult {
  decayed: number
  deactivated: number
}

export interface UpdateUserProfileParams {
  userId?: string
  key: string
  value: string
  source?: string
  confidence?: number
}

/** Payload stored in Qdrant alongside the embedding vector */
interface AgentMemoryPayload {
  memoryId: string
  agentId: string
  agentName: string
  category: string
  content: string
  context?: string
  importance: number
  source: string
  tags?: string
  sessionId?: string
  createdAt: string
}

// ==================== COLLECTION MANAGEMENT ====================

/**
 * Ensure the agent_memory collection exists in Qdrant.
 * Safe to call multiple times — checks existence first.
 * Uses the same embedding dimension as theopus_chunks (2048).
 */
export async function ensureAgentMemoryCollection(): Promise<boolean> {
  // Trigger cloud memory restore once per process (non-blocking if it fails)
  // This runs before any recallMemories/storeMemory call, ensuring local SQLite
  // is populated from Supabase cloud backup before serving the first chat request.
  restoreMemoriesFromCloud().catch(() => { /* non-critical */ })

  try {
    const collections = await qdrant.getCollections()
    const existingNames = new Set(collections.collections.map(c => c.name))

    if (existingNames.has(COLLECTION_AGENT_MEMORY)) {
      return true
    }

    await qdrant.createCollection(COLLECTION_AGENT_MEMORY, {
      vectors: {
        size: getEmbeddingDimension(),
        distance: 'Cosine',
      },
      // Phase 3: Scalar Quantization (INT8) — 4x memory savings, <1% accuracy loss.
      quantization_config: {
        scalar: {
          type: 'int8' as const,
          quantile: 0.99,
          always_ram: true,
        },
      },
      hnsw_config: {
        ef_construct: 128,
        m: 16,
        full_scan_threshold: 10000,
      },
      optimizers_config: {
        indexing_threshold: 20000,
      },
    })

    // Create payload indexes for filtering
    try {
      await qdrant.createPayloadIndex(COLLECTION_AGENT_MEMORY, {
        field_name: 'agentId',
        field_schema: 'keyword',
      })
      await qdrant.createPayloadIndex(COLLECTION_AGENT_MEMORY, {
        field_name: 'category',
        field_schema: 'keyword',
      })
      await qdrant.createPayloadIndex(COLLECTION_AGENT_MEMORY, {
        field_name: 'importance',
        field_schema: 'float',
      })
    } catch (indexErr) {
      const msg = indexErr instanceof Error ? indexErr.message : String(indexErr)
      if (!msg.includes('already exists') && !msg.includes('already has')) {
        console.warn('[AgentMemory] Payload index creation warning:', msg)
      }
    }

    console.log(`[AgentMemory] Created Qdrant collection: ${COLLECTION_AGENT_MEMORY} (${getEmbeddingDimension()}-dim vectors)`)
    return true
  } catch (err) {
    console.error('[AgentMemory] Failed to ensure collection:', err instanceof Error ? err.message : String(err))
    return false
  }
}

// ==================== RECALL MEMORIES ====================

/**
 * Proactive Memory Recall — find memories relevant to a query.
 *
 * Flow:
 *   1. Embed query with NVIDIA NIM (input_type: "query")
 *   2. Search Qdrant agent_memory collection
 *   3. Update access stats (accessCount++, lastAccessedAt)
 *   4. Log to MemoryAccessLog
 *
 * @param params - Recall parameters
 * @returns Array of recalled memories sorted by relevance
 */
export async function recallMemories(params: RecallParams): Promise<RecalledMemory[]> {
  const { agentId, query, topK = DEFAULT_TOP_K, category, minImportance = 0, sessionId } = params

  try {
    // Ensure collection exists
    await ensureAgentMemoryCollection()

    // Step 1: Embed the query using NVIDIA NIM
    const { vector: queryVector } = await generateQueryEmbedding(query)

    // Step 2: Build Qdrant filter
    const must: Array<Record<string, unknown>> = [
      { key: 'agentId', match: { value: agentId } },
    ]

    if (category) {
      must.push({ key: 'category', match: { value: category } })
    }

    if (minImportance > 0) {
      must.push({
        key: 'importance',
        range: { gte: minImportance },
      })
    }

    // Step 3: Search Qdrant
    const results = await qdrant.search(COLLECTION_AGENT_MEMORY, {
      vector: queryVector,
      filter: { must },
      limit: topK,
      with_payload: true,
      score_threshold: DEFAULT_MIN_SCORE,
    })

    if (results.length === 0) {
      return []
    }

    // Step 4: Process results — update access stats and log
    const recalled: RecalledMemory[] = []

    for (const result of results) {
      const payload = result.payload as unknown as AgentMemoryPayload
      const memoryId = payload?.memoryId

      if (!memoryId) continue

      // Check if memory is still active in SQLite
      const memory = await db.agentMemory.findUnique({ where: { id: memoryId } })
      if (!memory || !memory.isActive) continue

      // Update access stats
      try {
        await db.agentMemory.update({
          where: { id: memoryId },
          data: {
            accessCount: { increment: 1 },
            lastAccessedAt: new Date(),
          },
        })
      } catch {
        // Non-critical — don't break recall if stats update fails
      }

      // Log access
      try {
        await db.memoryAccessLog.create({
          data: {
            memoryId,
            agentId,
            sessionId: sessionId || null,
            query: query.slice(0, 500),
            relevance: result.score,
          },
        })
      } catch {
        // Non-critical — don't break recall if logging fails
      }

      recalled.push({
        id: memoryId,
        content: memory.content,
        category: memory.category,
        importance: memory.importance,
        relevance: result.score,
        context: memory.context,
      })
    }

    return recalled
  } catch (err) {
    console.error('[AgentMemory] Recall error:', err instanceof Error ? err.message : String(err))
    return []
  }
}

// ==================== STORE MEMORY ====================

/**
 * Store a new episodic memory.
 *
 * Flow:
 *   1. Generate embedding via NVIDIA NIM (input_type: "passage")
 *   2. Upsert to Qdrant agent_memory collection
 *   3. Save to SQLite AgentMemory with qdrantPointId
 *
 * @param params - Memory parameters
 * @returns Created memory ID and Qdrant point ID
 */
export async function storeMemory(params: StoreMemoryParams): Promise<StoreMemoryResult> {
  const {
    agentId,
    agentName,
    sessionId,
    category,
    content,
    context,
    importance = 0.5,
    source = 'auto',
    tags,
  } = params

  try {
    // Ensure collection exists
    await ensureAgentMemoryCollection()

    // Phase 5: Improved deduplication — vector similarity search + LLM merge
    // (instead of just prefix matching, we now do semantic similarity)
    try {
      // Generate embedding FIRST (needed for similarity search)
      const { vector, model: embeddingModel } = await generateEmbedding(content)

      // Search Qdrant for very similar memories (similarity > 0.92)
      try {
        const similar = await qdrant.search(COLLECTION_AGENT_MEMORY, {
          vector,
          filter: {
            must: [
              { key: 'agentId', match: { value: agentId } },
              { key: 'category', match: { value: category } },
            ],
          },
          limit: 5,
          score_threshold: 0.92, // very similar
          with_payload: true,
        })

        if (similar.length > 0) {
          // Found a very similar memory — merge instead of duplicate
          const existingPayload = similar[0].payload as AgentMemoryPayload
          const existingMemoryId = existingPayload?.memoryId
          if (existingMemoryId) {
            const existingMem = await db.agentMemory.findUnique({
              where: { id: existingMemoryId },
              select: { id: true, content: true, importance: true, qdrantPointId: true },
            })

            if (existingMem) {
              // Try LLM merge (Phase 5)
              try {
                const { mergeSimilarMemories } = await import('@/lib/memory-summarization')
                const merged = await mergeSimilarMemories(existingMem.content, content)

                if (merged && merged !== existingMem.content) {
                  // Update existing memory with merged content + bump importance
                  const newImportance = Math.min(1.0, (existingMem.importance || 0.5) + 0.1)

                  // Generate new embedding for merged content
                  const { vector: mergedVector } = await generateEmbedding(merged)

                  // Update SQLite
                  await db.agentMemory.update({
                    where: { id: existingMem.id },
                    data: {
                      content: merged,
                      importance: newImportance,
                      accessCount: { increment: 1 },
                      lastAccessedAt: new Date(),
                    },
                  })

                  // Update Qdrant point with new vector + content
                  if (existingMem.qdrantPointId) {
                    try {
                      await qdrant.upsert(COLLECTION_AGENT_MEMORY, {
                        wait: true,
                        points: [
                          {
                            id: existingMem.qdrantPointId,
                            vector: mergedVector,
                            payload: { ...existingPayload, content: merged, importance: newImportance },
                          },
                        ],
                      })
                    } catch {
                      // non-critical
                    }
                  }

                  console.log(`[AgentMemory] Merged similar memory for ${agentName}: "${merged.slice(0, 50)}..."`)
                  return { id: existingMem.id, qdrantPointId: existingMem.qdrantPointId || '' }
                }
              } catch {
                // Merge failed — fall through to old dedup check
              }

              // Fallback: skip duplicate (old behavior)
              console.log(`[AgentMemory] Skipping duplicate memory for agent ${agentName}: "${content.slice(0, 50)}..."`)
              await db.agentMemory.update({
                where: { id: existingMem.id },
                data: {
                  accessCount: { increment: 1 },
                  lastAccessedAt: new Date(),
                },
              })
              return { id: existingMem.id, qdrantPointId: existingMem.qdrantPointId || '' }
            }
          }
        }
      } catch (qdrantSearchErr) {
        // Vector search failed — fall back to prefix matching (old behavior)
        console.warn('[AgentMemory] Vector dedup failed, falling back to prefix:', qdrantSearchErr instanceof Error ? qdrantSearchErr.message : String(qdrantSearchErr))

        const contentPrefix = content.slice(0, 80).toLowerCase()
        const existingMemories = await db.agentMemory.findMany({
          where: { agentId, isActive: true, category },
          select: { id: true, content: true, qdrantPointId: true },
          take: 50,
          orderBy: { createdAt: 'desc' },
        })

        const duplicate = existingMemories.find(m =>
          m.content.toLowerCase().slice(0, 80) === contentPrefix
        )
        if (duplicate) {
          console.log(`[AgentMemory] Skipping duplicate (prefix match) for ${agentName}`)
          return { id: duplicate.id, qdrantPointId: duplicate.qdrantPointId || '' }
        }
      }

      // Phase 4: Classify domain (user | work | meta)
      const { classifyDomain } = await import('@/lib/memory-tiers')
      const domain = classifyDomain({ content, category, context })

      // Step 2: Create the SQLite record first (with domain + tier fields)
      const memory = await db.agentMemory.create({
        data: {
          agentId,
          agentName,
          sessionId: sessionId || null,
          category,
          content,
          context: context || null,
          importance,
          source,
          tags: tags ? JSON.stringify(tags) : null,
          embeddingModel,
          domain,
          tier: 'warm', // default to WARM tier
          isActive: true,
          accessCount: 0,
        },
      })

      // Step 3: Upsert to Qdrant with the memory ID in payload
      // Qdrant requires UUID or unsigned integer as point ID — generate a UUID
      const qdrantPointId = crypto.randomUUID()

      const payload: AgentMemoryPayload = {
        memoryId: memory.id,
        agentId,
        agentName,
        category,
        content,
        context: context || undefined,
        importance,
        source,
        tags: tags ? JSON.stringify(tags) : undefined,
        sessionId: sessionId || undefined,
        createdAt: memory.createdAt.toISOString(),
      }

      try {
        await qdrant.upsert(COLLECTION_AGENT_MEMORY, {
          points: [
            {
              id: qdrantPointId,
              vector,
              payload,
            },
          ],
        })
      } catch (qdrantErr) {
        console.error('[AgentMemory] Qdrant upsert error:', qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr))
        // Still return the memory — it's in SQLite even if Qdrant fails
      }

      // Step 4: Update the SQLite record with qdrantPointId
      await db.agentMemory.update({
        where: { id: memory.id },
        data: { qdrantPointId },
      })

      console.log(`[AgentMemory] Stored ${category} memory for agent ${agentName} (importance: ${importance}, domain: ${domain})`)

      // Step 5: Non-blocking push to Supabase (cloud persistence for memory)
      // Fire-and-forget — never block chat response, never throw on failure.
      // This backs up the new memory + its qdrantPointId so memory survives sandbox resets.
      ;(async () => {
        try {
          const { pushToSupabase } = await import('@/lib/supabase-sync')
          await pushToSupabase()
        } catch (e) {
          console.warn('[AgentMemory] Supabase push failed (non-critical):', e instanceof Error ? e.message : String(e))
        }
      })()

      return { id: memory.id, qdrantPointId }
    } catch (outerErr) {
      // Outer try failed (embedding generation, etc.)
      console.error('[AgentMemory] Store error:', outerErr instanceof Error ? outerErr.message : String(outerErr))
      throw outerErr
    }
  } catch (err) {
    console.error('[AgentMemory] Store outer error:', err instanceof Error ? err.message : String(err))
    throw err
  }
}

// ==================== EXTRACT MEMORIES FROM CONVERSATION ====================

/**
 * Extract memories from a chat exchange using LLM analysis.
 *
 * The LLM analyzes the conversation and extracts:
 *   - Facts: new factual knowledge learned
 *   - User info: information about the user (name, preferences, expertise)
 *   - Insights: deeper patterns or conclusions
 *   - Corrections: if the user corrected the agent
 *   - Procedures: step-by-step processes discussed
 *
 * For each extracted item → storeMemory() with appropriate category.
 * Also updates UserProfile if user information was detected.
 *
 * @param params - Conversation exchange parameters
 * @returns Count of memories created and profile updates
 */
export async function extractMemoriesFromConversation(params: ExtractMemoriesParams): Promise<ExtractMemoriesResult> {
  const { agentId, agentName, sessionId, userMessage, assistantMessage } = params

  try {
    const extractionPrompt = `You are a memory extraction system. Analyze the following conversation between a user and an AI assistant. Extract ALL memorable information that should be stored for future reference.

CONVERSATION:
---
User: ${userMessage}
Assistant: ${assistantMessage}
---

Extract information in the following categories. For each item, provide:
- category: one of "fact", "user_info", "insight", "correction", "procedure"
- content: a clear, self-contained statement of the memory (write it as a fact the agent should remember)
- context: brief context of what triggered this memory (the original query or situation)
- importance: 0.0 to 1.0 (how important is this to remember? 1.0 = critical, 0.3 = minor detail)
- tags: array of relevant tags for categorization

Categories:
- fact: New factual knowledge learned from this exchange
- user_info: Information about the user (name, preferences, expertise level, communication style, role, etc.)
- insight: Deeper patterns, conclusions, or realizations from the exchange
- correction: The user corrected the agent's mistake or misunderstanding
- procedure: Step-by-step processes, methods, or workflows discussed

IMPORTANT RULES:
1. Only extract information that is genuinely new and worth remembering
2. Write content as a standalone fact (e.g., "User prefers Python over JavaScript" not "They said they like Python")
3. Be generous with user_info — any detail about the user is valuable
4. Be conservative with importance — most things are 0.3-0.6, only truly critical info is 0.8+
5. If nothing memorable was discussed, return an empty array

Respond with ONLY a JSON array, no other text:
[
  {
    "category": "fact|user_info|insight|correction|procedure",
    "content": "the memory content as a standalone fact",
    "context": "what triggered this memory",
    "importance": 0.0-1.0,
    "tags": ["tag1", "tag2"]
  }
]`

    const result = await callLLM(extractionPrompt, undefined, 'memory-extraction', {
      temperature: 0.1,
      maxTokens: 2000,
      agentId,
      agentName,
    })

    if (!result.content || result.content.trim().length === 0) {
      return { memoriesCreated: 0, userProfileUpdates: 0 }
    }

    // Parse the LLM response
    let extractedItems: Array<{
      category: string
      content: string
      context?: string
      importance?: number
      tags?: string[]
    }>

    try {
      // Try to extract JSON from the response (might have markdown wrapping)
      const jsonMatch = result.content.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        return { memoriesCreated: 0, userProfileUpdates: 0 }
      }
      extractedItems = JSON.parse(jsonMatch[0])
    } catch {
      console.warn('[AgentMemory] Failed to parse LLM extraction response:', result.content.slice(0, 200))
      return { memoriesCreated: 0, userProfileUpdates: 0 }
    }

    if (!Array.isArray(extractedItems) || extractedItems.length === 0) {
      return { memoriesCreated: 0, userProfileUpdates: 0 }
    }

    // Store each extracted memory and track user profile updates
    let memoriesCreated = 0
    let userProfileUpdates = 0

    for (const item of extractedItems) {
      if (!item.content || !item.category) continue

      // Validate category
      const validCategories = ['fact', 'user_info', 'insight', 'correction', 'procedure']
      const category = validCategories.includes(item.category) ? item.category : 'fact'

      try {
        await storeMemory({
          agentId,
          agentName,
          sessionId,
          category: category as StoreMemoryParams['category'],
          content: item.content,
          context: item.context || userMessage.slice(0, 200),
          importance: Math.min(1, Math.max(0, item.importance ?? 0.5)),
          source: 'auto',
          tags: item.tags,
        })
        memoriesCreated++
      } catch (err) {
        console.warn('[AgentMemory] Failed to store extracted memory:', err instanceof Error ? err.message : String(err))
      }

      // If user_info, also update UserProfile
      if (category === 'user_info') {
        try {
          // Derive a profile key from the content
          // E.g., "User prefers Python over JavaScript" → key: "language_preference"
          // We use a simplified approach: use first ~50 chars as key hint
          const profileKey = deriveProfileKey(item.content)
          await updateUserProfile({
            key: profileKey,
            value: item.content,
            source: 'agent_observation',
            confidence: Math.min(1, Math.max(0, item.importance ?? 0.5)),
          })
          userProfileUpdates++
        } catch (err) {
          console.warn('[AgentMemory] Failed to update user profile:', err instanceof Error ? err.message : String(err))
        }
      }
    }

    console.log(`[AgentMemory] Extracted ${memoriesCreated} memories and ${userProfileUpdates} profile updates from conversation`)

    return { memoriesCreated, userProfileUpdates }
  } catch (err) {
    console.error('[AgentMemory] Memory extraction error:', err instanceof Error ? err.message : String(err))
    return { memoriesCreated: 0, userProfileUpdates: 0 }
  }
}

/**
 * Derive a short profile key from memory content.
 * Uses the first meaningful words, cleaned up as a key.
 */
function deriveProfileKey(content: string): string {
  // Take first ~50 chars, lowercase, replace spaces with underscores, remove special chars
  const cleaned = content
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join('_')

  return cleaned || 'general_info'
}

// ==================== DECAY MEMORIES ====================

/**
 * Memory Decay / Optimization — reduce importance of memories not accessed recently.
 *
 * Formula: newImportance = importance * (1 - decayRate * daysSinceLastAccess)
 * Memories with importance < DEACTIVATION_THRESHOLD are marked isActive = false.
 *
 * @param agentId - The agent whose memories to decay
 * @returns Count of decayed and deactivated memories
 */
export async function decayMemories(agentId: string): Promise<DecayResult> {
  try {
    const now = new Date()
    let decayed = 0
    let deactivated = 0

    // Phase 4: domain-aware decay multipliers
    // "user" domain decays at 0.5x rate (personal info stays longer)
    // "work" domain decays at 1.0x rate (default)
    // "meta" domain never decays (patterns about user interaction)
    const DOMAIN_DECAY_MULTIPLIERS: Record<string, number> = {
      user: 0.5,
      work: 1.0,
      meta: 0.0,
    }

    // Find all active memories for this agent
    const memories = await db.agentMemory.findMany({
      where: {
        agentId,
        isActive: true,
      },
    })

    for (const memory of memories) {
      // Phase 4: skip "meta" domain (never decays)
      const domain = (memory as { domain?: string }).domain || 'work'
      const decayMultiplier = DOMAIN_DECAY_MULTIPLIERS[domain] ?? 1.0
      if (decayMultiplier === 0) continue

      // Calculate days since last access (or creation if never accessed)
      const lastAccess = memory.lastAccessedAt || memory.createdAt
      const daysSinceAccess = (now.getTime() - lastAccess.getTime()) / (1000 * 60 * 60 * 24)

      // Skip recently accessed memories (< 1 day)
      if (daysSinceAccess < 1) continue

      // Apply decay formula (with domain multiplier)
      const effectiveDecayRate = DEFAULT_DECAY_RATE * decayMultiplier
      const newImportance = memory.importance * (1 - effectiveDecayRate * daysSinceAccess)

      if (newImportance < DEACTIVATION_THRESHOLD) {
        // Deactivate memory
        await db.agentMemory.update({
          where: { id: memory.id },
          data: {
            importance: newImportance,
            isActive: false,
          },
        })
        deactivated++
      } else if (Math.abs(newImportance - memory.importance) > 0.001) {
        // Update with decayed importance
        await db.agentMemory.update({
          where: { id: memory.id },
          data: { importance: newImportance },
        })
        decayed++
      }
    }

    // Also deactivate expired memories
    const expired = await db.agentMemory.updateMany({
      where: {
        agentId,
        isActive: true,
        expiresAt: { lt: now },
      },
      data: { isActive: false },
    })
    deactivated += expired.count

    if (decayed > 0 || deactivated > 0) {
      console.log(`[AgentMemory] Decay for agent ${agentId}: ${decayed} decayed, ${deactivated} deactivated`)
    }

    // Phase 4: Run tier transitions (archive decayed + cleanup expired archives)
    // Only run if there were any decayed/deactivated memories (avoid wasted work)
    if (deactivated > 0) {
      try {
        const { runTierTransitions } = await import('@/lib/memory-tiers')
        const tierResult = await runTierTransitions(agentId)
        if (tierResult.archived > 0 || tierResult.cleaned > 0) {
          console.log(`[AgentMemory] Tier transitions: ${tierResult.archived} archived, ${tierResult.cleaned} cleaned`)
        }
      } catch (tierErr) {
        console.warn('[AgentMemory] Tier transitions failed:', tierErr instanceof Error ? tierErr.message : String(tierErr))
      }
    }

    return { decayed, deactivated }
  } catch (err) {
    console.error('[AgentMemory] Decay error:', err instanceof Error ? err.message : String(err))
    return { decayed: 0, deactivated: 0 }
  }
}

// ==================== USER PROFILE ====================

/**
 * Get the user profile — all active profile entries for a user.
 *
 * @param userId - User identifier (defaults to "default")
 * @returns Array of active profile entries
 */
export async function getUserProfile(userId: string = 'default'): Promise<Array<{
  id: string
  key: string
  value: string
  source: string
  confidence: number
  accessCount: number
  createdAt: Date
  updatedAt: Date
}>> {
  try {
    return await db.userProfile.findMany({
      where: {
        userId,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    })
  } catch (err) {
    console.error('[AgentMemory] getUserProfile error:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Update or create a user profile entry.
 *
 * @param params - Profile update parameters
 * @returns The updated or created profile entry
 */
export async function updateUserProfile(params: UpdateUserProfileParams): Promise<{
  id: string
  userId: string
  key: string
  value: string
  source: string
  confidence: number
  accessCount: number
  isActive: boolean
  createdAt: Date
  updatedAt: Date
} | null> {
  const { userId = 'default', key, value, source = 'auto', confidence = 0.5 } = params

  try {
    const profile = await db.userProfile.upsert({
      where: {
        userId_key: { userId, key },
      },
      update: {
        value,
        source,
        confidence: Math.min(1, Math.max(0, confidence)),
        accessCount: { increment: 1 },
      },
      create: {
        userId,
        key,
        value,
        source,
        confidence: Math.min(1, Math.max(0, confidence)),
      },
    })

    return profile
  } catch (err) {
    console.error('[AgentMemory] updateUserProfile error:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ==================== CHAT MESSAGES ====================

/**
 * Save chat messages for a session — bulk create.
 *
 * @param sessionId - The session ID
 * @param messages - Array of message objects to save
 */
export async function saveChatMessages(
  sessionId: string,
  messages: Array<{
    role: string
    content: string
    model?: string
    provider?: string
    metadata?: Record<string, unknown>
  }>
): Promise<number> {
  try {
    if (messages.length === 0) return 0

    const result = await db.chatMessage.createMany({
      data: messages.map(msg => ({
        sessionId,
        role: msg.role,
        content: msg.content,
        model: msg.model || null,
        provider: msg.provider || null,
        metadata: msg.metadata ? JSON.stringify(msg.metadata) : null,
      })),
    })

    return result.count
  } catch (err) {
    console.error('[AgentMemory] saveChatMessages error:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

/**
 * Get all messages for a session, ordered by creation time.
 *
 * @param sessionId - The session ID
 * @returns Array of chat messages in chronological order
 */
export async function getSessionMessages(sessionId: string): Promise<Array<{
  id: string
  sessionId: string
  role: string
  content: string
  model: string | null
  provider: string | null
  metadata: string | null
  createdAt: Date
}>> {
  try {
    return await db.chatMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    })
  } catch (err) {
    console.error('[AgentMemory] getSessionMessages error:', err instanceof Error ? err.message : String(err))
    return []
  }
}

// ==================== QDRANT VECTOR BACKFILL ====================

/**
 * FIX (memories unrecallable after reset): restoreMemoriesFromCloud brings back
 * the SQLite rows (including qdrantPointId), but the local Qdrant instance is
 * ephemeral — after a sandbox reset the agent_memory collection is EMPTY while
 * recallMemories() searches Qdrant-first. All restored memories were therefore
 * invisible to semantic recall until new ones happened to be stored.
 *
 * This backfill re-embeds every ACTIVE memory whose Qdrant point is missing
 * (null qdrantPointId, or point no longer exists in the collection) and upserts
 * it back into agent_memory, updating the SQLite row with the new point ID.
 *
 * Idempotent: guarded once per process; re-runs are cheap (existing points are
 * skipped via a scroll of current point IDs).
 */
export async function backfillMemoryVectors(): Promise<number> {
  const globalForBackfill = globalThis as unknown as { __memoryVectorsBackfilled?: boolean }
  if (globalForBackfill.__memoryVectorsBackfilled) return 0
  globalForBackfill.__memoryVectorsBackfilled = true

  try {
    await ensureAgentMemoryCollection()

    // 1. All active memories (WARM tier — the ones recall searches for)
    const memories = await db.agentMemory.findMany({
      where: { isActive: true },
      select: {
        id: true, agentId: true, agentName: true, category: true, content: true,
        context: true, importance: true, source: true, tags: true, sessionId: true,
        qdrantPointId: true, createdAt: true,
      },
      take: 2000,
    })
    if (memories.length === 0) {
      console.log('[AgentMemory] Vector backfill: no active memories — nothing to do')
      return 0
    }

    // 2. Which Qdrant points currently exist in the collection?
    const existingPointIds = new Set<string>()
    try {
      let offset: string | number | undefined = undefined
      do {
        const res = await qdrant.scroll(COLLECTION_AGENT_MEMORY, {
          limit: 100,
          offset,
          with_payload: false,
          with_vector: false,
        })
        for (const p of res.points) existingPointIds.add(String(p.id))
        offset = res.next_page_offset
      } while (offset)
    } catch {
      // Collection may be empty/unreachable — treat as no existing points
    }

    // 3. Memories missing from Qdrant
    const missing = memories.filter(m => !m.qdrantPointId || !existingPointIds.has(m.qdrantPointId))
    if (missing.length === 0) {
      console.log(`[AgentMemory] Vector backfill: all ${memories.length} memories already in Qdrant — skipping`)
      return 0
    }

    console.log(`[AgentMemory] Backfilling ${missing.length}/${memories.length} memory vectors to Qdrant...`)

    // 4. Batch embed + upsert (small batches; failures skip individual memories)
    let backfilled = 0
    const BATCH = 20
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH)
      try {
        const embeddings = await generateEmbeddingBatch(batch.map(m => m.content))
        for (let j = 0; j < batch.length; j++) {
          const m = batch[j]
          const emb = embeddings[j]
          if (!emb?.vector || emb.vector.length === 0) continue
          try {
            const pointId = crypto.randomUUID()
            await qdrant.upsert(COLLECTION_AGENT_MEMORY, {
              points: [{
                id: pointId,
                vector: emb.vector,
                payload: {
                  memoryId: m.id,
                  agentId: m.agentId,
                  agentName: m.agentName ?? undefined,
                  category: m.category,
                  content: m.content,
                  context: m.context ?? undefined,
                  importance: m.importance,
                  source: m.source,
                  tags: m.tags ?? undefined,
                  sessionId: m.sessionId ?? undefined,
                  createdAt: m.createdAt.toISOString(),
                } as AgentMemoryPayload,
              }],
            })
            await db.agentMemory.update({ where: { id: m.id }, data: { qdrantPointId: pointId } })
            backfilled++
          } catch {
            // Individual point failure — skip, keep going
          }
        }
      } catch (batchErr) {
        console.warn('[AgentMemory] Backfill batch embedding failed:', batchErr instanceof Error ? batchErr.message : String(batchErr))
      }
    }

    console.log(`[AgentMemory] Vector backfill complete: ${backfilled}/${missing.length} memories re-embedded`)
    return backfilled
  } catch (err) {
    // Reset flag so a later call can retry
    globalForBackfill.__memoryVectorsBackfilled = false
    console.warn('[AgentMemory] Vector backfill failed (non-critical):', err instanceof Error ? err.message : String(err))
    return 0
  }
}

// ==================== CLOUD RESTORE (Supabase → SQLite) ====================

/**
 * Restore all memories from Supabase cloud backup into local SQLite.
 *
 * Called ONCE per process lifetime (guarded by globalForMemoryRestored flag).
 * Pulls AgentMemory + MemoryArchive + MemoryAccessLog from Supabase backup
 * tables and upserts them into local SQLite — ensuring memory survives
 * sandbox resets.
 *
 * Non-blocking on failure: if Supabase is unreachable or backup tables
 * don't exist yet, logs a warning and continues (app still works with
 * empty local memory).
 *
 * @returns number of memory records restored
 */
export async function restoreMemoriesFromCloud(): Promise<number> {
  const globalForMemoryRestored = globalThis as unknown as { __memoriesRestored?: boolean }
  if (globalForMemoryRestored.__memoriesRestored) return 0
  globalForMemoryRestored.__memoriesRestored = true

  try {
    const { pullFromSupabase, isSupabaseConfigured } = await import('@/lib/supabase-sync')
    if (!isSupabaseConfigured()) {
      console.log('[AgentMemory] Supabase not configured — skipping cloud memory restore')
      return 0
    }

    console.log('[AgentMemory] Restoring memories from Supabase cloud backup...')
    const result = await pullFromSupabase()

    // Count memory-specific tables restored
    const memResult = result.results.find(r => r.table === 'AgentMemory')
    const archiveResult = result.results.find(r => r.table === 'MemoryArchive')
    const logResult = result.results.find(r => r.table === 'MemoryAccessLog')
    const restored = (memResult?.pulled || 0) + (archiveResult?.pulled || 0)

    console.log(
      `[AgentMemory] Cloud restore complete: ${memResult?.pulled || 0} memories, ` +
      `${archiveResult?.pulled || 0} archives, ${logResult?.pulled || 0} access logs ` +
      `(${result.durationMs}ms)`
    )

    // FIX (unrecallable memories): rebuilt SQLite rows still point at Qdrant point
    // IDs that no longer exist in the local (ephemeral) collection. Re-embed the
    // restored memories so semantic recall works again immediately. Fire-and-forget
    // — never blocks the caller (chat first-load).
    void backfillMemoryVectors().catch(() => { /* non-critical */ })

    return restored
  } catch (err) {
    console.warn(
      '[AgentMemory] Cloud restore failed (non-critical):',
      err instanceof Error ? err.message : String(err)
    )
    // Reset flag so it can retry on next call
    globalForMemoryRestored.__memoriesRestored = false
    return 0
  }
}
