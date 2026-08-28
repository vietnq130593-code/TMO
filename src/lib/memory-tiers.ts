/**
 * Memory Tier Architecture — Phase 4
 *
 * Implements 3-tier memory system:
 *   HOT  (WorkingMemory table) → current session, expires after 1h
 *   WARM (AgentMemory table)   → active long-term, isActive=true
 *   COLD (MemoryArchive table) → compressed summary, expires after 90 days
 *
 * Transitions:
 *   1. HOT → WARM: promoteWorkingMemoryToWarm()
 *      Called when session ends or WorkingMemory expires.
 *      LLM extracts insights from working memory, stores as AgentMemory.
 *
 *   2. WARM → COLD: archiveColdMemories()
 *      Called by decayMemories() when importance < ARCHIVE_THRESHOLD.
 *      Groups similar memories, summarizes via LLM (Phase 5), creates MemoryArchive.
 *
 *   3. COLD → DELETE: cleanupExpiredArchives()
 *      Hard-deletes MemoryArchive records past their expiresAt (90 days).
 *      Also removes their Qdrant points.
 *
 * Domain-aware decay:
 *   - "user" domain: decays at 0.5x rate (personal info stays longer)
 *   - "work" domain: decays at 1.0x rate (default)
 *   - "meta" domain: never decays (patterns about user interaction)
 */

import { db } from '@/lib/db'
import { qdrant } from '@/lib/qdrant'
import { generateEmbedding } from '@/lib/embeddings'
import { storeMemory } from '@/lib/agent-memory'
import { summarizeMemories } from './memory-summarization'

// ==================== CONFIG ====================

/** Importance threshold below which WARM memories are archived to COLD */
export const ARCHIVE_THRESHOLD = 0.1

/** Default decay rate per day (multiplied by domain factor) */
export const BASE_DECAY_RATE = 0.02

/** Domain-specific decay multipliers */
const DOMAIN_DECAY_MULTIPLIERS: Record<string, number> = {
  user: 0.5, // personal info decays slowly
  work: 1.0, // default rate
  meta: 0.0, // never decays — patterns about user interaction
}

/** COLD archive TTL — 90 days */
const COLD_TTL_DAYS = 90

/** Working memory TTL — 1 hour after creation */
const WORKING_MEMORY_TTL_MS = 60 * 60 * 1000

/** Max memories to archive in one batch (safety cap) */
const MAX_ARCHIVE_BATCH = 50

/** Min memories required to form a cluster for summarization */
const MIN_CLUSTER_SIZE = 2

// ==================== TYPES ====================

export interface TierTransitionResult {
  promoted: number      // HOT → WARM count
  archived: number       // WARM → COLD count
  cleaned: number       // COLD → DELETE count
  errors: string[]
  durationMs: number
}

// ==================== 1. HOT → WARM (PROMOTION) ====================

/**
 * Promote expired WorkingMemory records to AgentMemory (WARM).
 * Called when:
 *   - Session ends (chat route can call this)
 *   - Periodic cleanup (every N messages)
 *
 * For each expired WorkingMemory record:
 *   - If role=user/assistant: LLM extracts insights → store as AgentMemory
 *   - If role=recall: skip (already in AgentMemory)
 *   - Delete from WorkingMemory table
 */
export async function promoteWorkingMemoryToWarm(
  agentId: string,
  sessionId?: string
): Promise<{ promoted: number; errors: string[] }> {
  const errors: string[] = []
  let promoted = 0
  const now = new Date()

  try {
    // Find expired working memory records
    const where: { agentId: string; expiresAt?: { lt: Date } } = { agentId }
    if (sessionId) {
      where.sessionId = sessionId
    } else {
      where.expiresAt = { lt: now }
    }

    const workingMemories = await db.workingMemory.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 100, // cap per call
    })

    if (workingMemories.length === 0) {
      return { promoted: 0, errors: [] }
    }

    console.log(`[MemoryTiers] Promoting ${workingMemories.length} working memories to WARM for agent ${agentId}`)

    // Group by session for LLM extraction (1 LLM call per session)
    const bySession = new Map<string, typeof workingMemories>()
    for (const wm of workingMemories) {
      const arr = bySession.get(wm.sessionId) || []
      arr.push(wm)
      bySession.set(wm.sessionId, arr)
    }

    // Lazy import to avoid circular deps
    const { extractMemoriesFromConversation } = await import('@/lib/agent-memory')

    for (const [sessId, memories] of bySession) {
      try {
        // Find user + assistant messages to extract from
        const userMsgs = memories.filter(m => m.role === 'user').map(m => m.content).join('\n')
        const assistantMsgs = memories.filter(m => m.role === 'assistant').map(m => m.content).join('\n')

        if (userMsgs && assistantMsgs) {
          // Use existing extraction logic
          const result = await extractMemoriesFromConversation({
            agentId,
            agentName: memories[0]?.agentId || 'unknown',
            sessionId: sessId,
            userMessage: userMsgs,
            assistantMessage: assistantMsgs,
          })
          promoted += result.memoriesCreated
        }

        // Delete working memory records (regardless of extraction success)
        await db.workingMemory.deleteMany({
          where: { agentId, sessionId: sessId },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[MemoryTiers] Failed to promote session ${sessId}:`, msg)
        errors.push(`Session ${sessId}: ${msg}`)
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`promoteWorkingMemoryToWarm: ${msg}`)
  }

  return { promoted, errors }
}

/**
 * Add a new entry to WorkingMemory (HOT tier).
 * Called by chat route for each message in a session.
 */
export async function addToWorkingMemory(params: {
  agentId: string
  sessionId: string
  content: string
  role: 'user' | 'assistant' | 'system' | 'recall'
  importance?: number
}): Promise<void> {
  try {
    await db.workingMemory.create({
      data: {
        agentId: params.agentId,
        sessionId: params.sessionId,
        content: params.content.slice(0, 5000), // cap content length
        role: params.role,
        importance: params.importance ?? 0.8,
        expiresAt: new Date(Date.now() + WORKING_MEMORY_TTL_MS),
      },
    })
  } catch (err) {
    // Non-critical — don't break chat if working memory fails
    console.warn('[MemoryTiers] addToWorkingMemory failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Get current working memory for a session (for context injection).
 */
export async function getWorkingMemory(
  agentId: string,
  sessionId: string,
  limit = 10
): Promise<Array<{ content: string; role: string; importance: number; createdAt: Date }>> {
  try {
    return await db.workingMemory.findMany({
      where: { agentId, sessionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { content: true, role: true, importance: true, createdAt: true },
    })
  } catch {
    return []
  }
}

/**
 * Get recent UNEXPIRED working memory across ALL sessions of an agent
 * (HOT entries from sessions khác — vẫn còn trong TTL 1h).
 *
 * USER REQUEST 2026-08-28 (Working Memory wiring): quá trình làm việc với
 * workspace (tool đã chạy, file đã đọc, kết quả) ghi vào HOT theo session;
 * khi user mở session mới trong TTL, agent vẫn thấy hoạt động gần đây qua
 * digest này — không phải chạy lại tool để "nhớ lại".
 */
export async function getRecentWorkingMemory(
  agentId: string,
  limit = 8
): Promise<Array<{ content: string; role: string; sessionId: string; createdAt: Date }>> {
  try {
    return await db.workingMemory.findMany({
      where: { agentId, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { content: true, role: true, sessionId: true, createdAt: true },
    })
  } catch {
    return []
  }
}

// ==================== 2. WARM → COLD (ARCHIVE) ====================

/**
 * Archive WARM memories that have decayed below ARCHIVE_THRESHOLD.
 *
 * Process:
 *   1. Find AgentMemory where isActive=false OR importance < ARCHIVE_THRESHOLD
 *   2. Group by similarity (cluster)
 *   3. Summarize each cluster via LLM (Phase 5)
 *   4. Create MemoryArchive record with summary
 *   5. Delete source AgentMemory records + Qdrant points
 *
 * Called by decayMemories() after applying decay.
 */
export async function archiveColdMemories(agentId: string): Promise<{ archived: number; errors: string[] }> {
  const errors: string[] = []
  let archived = 0

  try {
    // Find candidates for archiving
    const candidates = await db.agentMemory.findMany({
      where: {
        agentId,
        OR: [
          { importance: { lt: ARCHIVE_THRESHOLD } },
          { isActive: false },
        ],
        tier: 'warm', // only archive WARM (don't re-archive COLD)
      },
      orderBy: { importance: 'asc' },
      take: MAX_ARCHIVE_BATCH,
    })

    if (candidates.length === 0) {
      return { archived: 0, errors: [] }
    }

    console.log(`[MemoryTiers] Archiving ${candidates.length} cold memories for agent ${agentId}`)

    // Group by domain first (don't mix user/work/meta)
    const byDomain = new Map<string, typeof candidates>()
    for (const mem of candidates) {
      const domain = mem.domain || 'work'
      const arr = byDomain.get(domain) || []
      arr.push(mem)
      byDomain.set(domain, arr)
    }

    for (const [domain, domainMems] of byDomain) {
      // Cluster by similarity (using embedding vectors from Qdrant)
      const clusters = await clusterBySimilarity(domainMems)

      for (const cluster of clusters) {
        if (cluster.length < MIN_CLUSTER_SIZE) {
          // Single memory — archive without summarization
          if (cluster.length === 1) {
            await archiveSingleMemory(cluster[0], domain)
            archived++
          }
          continue
        }

        // Multiple memories — summarize via LLM (Phase 5)
        try {
          const summary = await summarizeMemories(cluster.map(m => m.content))
          if (!summary) {
            // Summarization failed — archive individually
            for (const m of cluster) {
              await archiveSingleMemory(m, domain)
              archived++
            }
            continue
          }

          // Generate embedding for the summary
          const { vector, model } = await generateEmbedding(summary)
          const qdrantPointId = crypto.randomUUID()

          // Upsert summary embedding to Qdrant (agent_memory collection)
          try {
            await qdrant.upsert('agent_memory', {
              wait: true,
              points: [
                {
                  id: qdrantPointId,
                  vector,
                  payload: {
                    memoryId: `archive:${Date.now()}`,
                    agentId,
                    agentName: cluster[0].agentName,
                    category: 'archived',
                    content: summary,
                    importance: 0.3,
                    source: 'archive-summarization',
                    tags: JSON.stringify(['archived', 'summarized']),
                    sessionId: undefined,
                    createdAt: new Date().toISOString(),
                    tier: 'cold',
                  },
                },
              ],
            })
          } catch (qdrantErr) {
            console.warn('[MemoryTiers] Qdrant upsert for archive failed:', qdrantErr instanceof Error ? qdrantErr.message : String(qdrantErr))
            // continue anyway — SQLite is the primary store
          }

          // Create MemoryArchive record
          await db.memoryArchive.create({
            data: {
              agentId,
              originalIds: JSON.stringify(cluster.map(m => m.id)),
              summaryContent: summary,
              domain,
              importance: 0.3,
              sourceCount: cluster.length,
              qdrantPointId,
              embeddingModel: model,
              expiresAt: new Date(Date.now() + COLD_TTL_DAYS * 24 * 60 * 60 * 1000),
            },
          })

          // Delete source AgentMemory records + their Qdrant points
          for (const m of cluster) {
            if (m.qdrantPointId) {
              try {
                await qdrant.delete('agent_memory', {
                  points: [m.qdrantPointId],
                  wait: true,
                })
              } catch {
                // non-critical
              }
            }
            await db.agentMemory.delete({ where: { id: m.id } })
          }

          archived += cluster.length
          console.log(`[MemoryTiers] Archived cluster: ${cluster.length} memories → 1 summary (${summary.slice(0, 80)}...)`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.warn('[MemoryTiers] Cluster summarization failed:', msg)
          errors.push(`Cluster: ${msg}`)
          // Fallback: archive individually
          for (const m of cluster) {
            await archiveSingleMemory(m, domain)
            archived++
          }
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`archiveColdMemories: ${msg}`)
  }

  return { archived, errors }
}

/**
 * Archive a single memory without LLM summarization (used for single-item archives).
 */
async function archiveSingleMemory(mem: {
  id: string
  agentId: string
  agentName: string
  content: string
  domain: string
  qdrantPointId: string | null
  embeddingModel: string | null
  importance: number
}, domain: string): Promise<void> {
  try {
    // Create archive record (use content as summary directly)
    await db.memoryArchive.create({
      data: {
        agentId: mem.agentId,
        originalIds: JSON.stringify([mem.id]),
        summaryContent: mem.content.slice(0, 1000), // cap summary length
        domain,
        importance: Math.max(0.2, mem.importance),
        sourceCount: 1,
        qdrantPointId: mem.qdrantPointId,
        embeddingModel: mem.embeddingModel,
        expiresAt: new Date(Date.now() + COLD_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    })

    // Mark original memory as cold-tier (don't delete yet — keep for reference)
    // Actually, we DO delete to avoid duplication
    await db.agentMemory.delete({ where: { id: mem.id } })

    // Note: Qdrant point NOT deleted — kept for archive search
  } catch (err) {
    console.warn('[MemoryTiers] archiveSingleMemory failed:', err instanceof Error ? err.message : String(err))
    throw err
  }
}

/**
 * Cluster memories by vector similarity.
 * Uses Qdrant search to find similar memories, groups them.
 * Memories with similarity > 0.85 are grouped together.
 */
async function clusterBySimilarity(
  memories: Array<{ id: string; content: string; qdrantPointId: string | null }>
): Promise<Array<typeof memories>> {
  if (memories.length <= 1) return [memories]

  const clusters: Array<typeof memories> = []
  const assigned = new Set<string>()
  const SIMILARITY_THRESHOLD = 0.85

  for (const mem of memories) {
    if (assigned.has(mem.id)) continue

    // Start a new cluster with this memory
    const cluster = [mem]
    assigned.add(mem.id)

    // Find similar memories via Qdrant (if this memory has a point ID)
    if (mem.qdrantPointId) {
      try {
        // Use the existing point's vector to search for similar
        const similar = await qdrant.search('agent_memory', {
          filter: {
            must: [
              { key: 'memoryId', match: { any: memories.filter(m => !assigned.has(m.id)).map(m => m.id) } },
            ],
          },
          vector: await getVectorForMemory(mem),
          limit: 10,
          score_threshold: SIMILARITY_THRESHOLD,
          with_payload: false,
        })

        for (const result of similar) {
          const matchedMem = memories.find(m => m.id === (result.payload?.memoryId as string))
          if (matchedMem && !assigned.has(matchedMem.id)) {
            cluster.push(matchedMem)
            assigned.add(matchedMem.id)
          }
        }
      } catch {
        // Vector search failed — cluster by content prefix as fallback
        const prefix = mem.content.slice(0, 50).toLowerCase()
        for (const other of memories) {
          if (assigned.has(other.id)) continue
          if (other.content.slice(0, 50).toLowerCase() === prefix) {
            cluster.push(other)
            assigned.add(other.id)
          }
        }
      }
    } else {
      // No Qdrant point — cluster by content prefix
      const prefix = mem.content.slice(0, 50).toLowerCase()
      for (const other of memories) {
        if (assigned.has(other.id)) continue
        if (other.content.slice(0, 50).toLowerCase() === prefix) {
          cluster.push(other)
          assigned.add(other.id)
        }
      }
    }

    clusters.push(cluster)
  }

  return clusters
}

/**
 * Get the vector for a memory (re-embed if no Qdrant point).
 */
async function getVectorForMemory(mem: { content: string; qdrantPointId: string | null }): Promise<number[]> {
  if (mem.qdrantPointId) {
    try {
      const points = await qdrant.retrieve('agent_memory', {
        ids: [mem.qdrantPointId],
        with_vector: true,
        with_payload: false,
      })
      if (points.length > 0 && Array.isArray(points[0].vector)) {
        return points[0].vector as number[]
      }
    } catch {
      // fall through to re-embed
    }
  }
  // Re-embed content
  const { vector } = await generateEmbedding(mem.content)
  return vector
}

// ==================== 3. COLD → DELETE (CLEANUP) ====================

/**
 * Hard-delete MemoryArchive records past their expiresAt (90 days).
 * Also removes their Qdrant points.
 *
 * Called by decayMemories() periodically.
 */
export async function cleanupExpiredArchives(): Promise<{ cleaned: number; errors: string[] }> {
  const errors: string[] = []
  let cleaned = 0

  try {
    const expired = await db.memoryArchive.findMany({
      where: { expiresAt: { lt: new Date() } },
      take: MAX_ARCHIVE_BATCH,
    })

    if (expired.length === 0) {
      return { cleaned: 0, errors: [] }
    }

    console.log(`[MemoryTiers] Cleaning up ${expired.length} expired archive records`)

    for (const archive of expired) {
      // Delete Qdrant point
      if (archive.qdrantPointId) {
        try {
          await qdrant.delete('agent_memory', {
            points: [archive.qdrantPointId],
            wait: true,
          })
        } catch {
          // non-critical
        }
      }

      // Delete SQLite record
      await db.memoryArchive.delete({ where: { id: archive.id } })
      cleaned++
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    errors.push(`cleanupExpiredArchives: ${msg}`)
  }

  return { cleaned, errors }
}

// ==================== 4. DOMAIN CLASSIFICATION ====================

/**
 * Classify a memory into domain (user | work | meta).
 * Used by storeMemory() when creating new AgentMemory records.
 *
 * Heuristics:
 *   - "user_info" category → "user" domain
 *   - Mentions of personal pronouns + preferences → "user" domain
 *   - Code/technical terms → "work" domain
 *   - Patterns about user interaction style → "meta" domain
 */
export function classifyDomain(params: {
  content: string
  category: string
  context?: string | null
}): 'user' | 'work' | 'meta' {
  const { content, category, context } = params
  const text = `${content} ${context || ''}`.toLowerCase()

  // "user_info" category always goes to "user" domain
  if (category === 'user_info') return 'user'

  // Personal pronouns + preference keywords → user domain
  const userPatterns = [
    /\b(i|me|my|mine|i'm|i am|i'd|i will|i'll|i have|i've|i like|i prefer|i hate|i want|i need)\b/i,
    /\b(user|người dùng|khách hàng|tôi|của tôi|của tôi|tôi thích|tôi muốn)\b/i,
    /\b(my name is|i'm called|call me|tên tôi là)\b/i,
    /\b(prefer|like|hate|love|favorite|sở thích|thích|ghét)\b/i,
  ]
  if (userPatterns.some(p => p.test(text))) return 'user'

  // Meta patterns — about how user interacts
  const metaPatterns = [
    /\b(always asks|never responds|typically|usually|pattern|habit|routine)\b/i,
    /\b(asks in |responds in|writes in|thinks in )/i,
  ]
  if (metaPatterns.some(p => p.test(text))) return 'meta'

  // Default: work domain
  return 'work'
}

// ==================== 5. MAIN ORCHESTRATOR ====================

/**
 * Run all tier transitions for an agent.
 * Called by decayMemories() periodically.
 *
 * Returns combined result of all 3 transitions.
 */
export async function runTierTransitions(agentId: string): Promise<TierTransitionResult> {
  const startTime = Date.now()
  const errors: string[] = []
  let promoted = 0
  let archived = 0
  let cleaned = 0

  // 1. Promote expired working memories to WARM
  try {
    const promoResult = await promoteWorkingMemoryToWarm(agentId)
    promoted = promoResult.promoted
    errors.push(...promoResult.errors)
  } catch (err) {
    errors.push(`promotion: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. Archive decayed WARM memories to COLD
  try {
    const archResult = await archiveColdMemories(agentId)
    archived = archResult.archived
    errors.push(...archResult.errors)
  } catch (err) {
    errors.push(`archive: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 3. Clean up expired COLD archives
  try {
    const cleanResult = await cleanupExpiredArchives()
    cleaned = cleanResult.cleaned
    errors.push(...cleanResult.errors)
  } catch (err) {
    errors.push(`cleanup: ${err instanceof Error ? err.message : String(err)}`)
  }

  const durationMs = Date.now() - startTime
  console.log(`[MemoryTiers] Transitions for ${agentId}: promoted=${promoted}, archived=${archived}, cleaned=${cleaned} (${durationMs}ms)`)

  return { promoted, archived, cleaned, errors, durationMs }
}
