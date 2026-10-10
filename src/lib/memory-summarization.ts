/**
 * Memory Summarization — Phase 5
 *
 * LLM-based compression of multiple similar memories into a single summary.
 *
 * Use cases:
 *   1. WARM → COLD transition (archiveColdMemories in memory-tiers.ts):
 *      Groups of 2-10 similar memories → 1 summary (90% size reduction)
 *
 *   2. Deduplication (improveDedup in storeMemory):
 *      When a new memory is very similar to an existing one, merge them
 *      instead of skipping or creating a duplicate.
 *
 * Compression techniques implemented:
 *   - LLM summarization (this file)
 *   - Vector similarity dedup (in agent-memory.ts storeMemory)
 *
 * Cost: ~500-2000 tokens per summarization call.
 * Frequency: only when memories decay below archive threshold (low frequency).
 */

import { callUtilityLLM } from '@/lib/llm'
import { rougeL } from '@/lib/stats'
import { recordDigestGateEvent } from '@/lib/digest-gate-events'

// ==================== CONFIG ====================

/** Min memories required to bother summarizing */
const MIN_MEMORIES_TO_SUMMARIZE = 2

/** Max memories per summarization batch (keep prompt manageable) */
const MAX_MEMORIES_PER_BATCH = 10

/** Max chars per memory content in prompt (truncate to avoid bloat) */
const MAX_CHARS_PER_MEMORY = 300

/** Target summary length (chars) */
const TARGET_SUMMARY_LENGTH = 200

/**
 * P3-M4 (BLUEPRINT §P3-M4) — ROUGE-L recall gate cho summary nén bộ nhớ.
 * Summary nén ~90% kích thước nên KHÔNG đòi coverage cao như digest (0.7) —
 * ngưỡng 0.3 đo "còn giữ được CHỦ ĐỀ chung của nhóm mẫu tương tự không".
 * Rớt gate → fallback batch[0] (đường an toàn sẵn có — giữ nguyên 1 mẫu
 * nguồn, mất thông tin ĐẢM BẢO bằng 0). Rollback = set 0.
 * Env SUMMARY_ROUGE_RECALL_MIN điều chỉnh không cần deploy lại.
 */
export const SUMMARY_ROUGE_RECALL_MIN = (() => {
  const v = Number(process.env.SUMMARY_ROUGE_RECALL_MIN)
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.3
})()

// ==================== MAIN ENTRY ====================

/**
 * Summarize a list of memory contents into a single compressed statement.
 *
 * Returns null if:
 *   - Less than MIN_MEMORIES_TO_SUMMARIZE memories
 *   - LLM call fails
 *   - LLM returns empty/garbage
 *
 * @param memories Array of memory content strings
 * @returns Summary string, or null on failure
 */
export async function summarizeMemories(memories: string[]): Promise<string | null> {
  if (!memories || memories.length < MIN_MEMORIES_TO_SUMMARIZE) {
    return null
  }

  // Cap the batch size
  const batch = memories.slice(0, MAX_MEMORIES_PER_BATCH)

  // Truncate each memory to keep prompt manageable
  const truncated = batch.map((m, i) =>
    `[${i + 1}] ${m.slice(0, MAX_CHARS_PER_MEMORY)}${m.length > MAX_CHARS_PER_MEMORY ? '...' : ''}`
  ).join('\n')

  const prompt = `You are a memory compression system. The following ${batch.length} memory entries are related and need to be merged into a SINGLE concise summary.

MEMORY ENTRIES:
${truncated}

INSTRUCTIONS:
1. Identify the COMMON theme/fact across all entries.
2. Merge into a SINGLE statement that captures the essential information.
3. Resolve conflicts: if entries disagree, note both views.
4. Be CONCISE — target ${TARGET_SUMMARY_LENGTH} characters or less.
5. Preserve specific details (names, dates, numbers) when they add value.
6. Write in the SAME language as the source memories (Vietnamese, English, etc.).
7. Output ONLY the summary, no preamble, no explanation, no markdown.

Summary:`

  try {
    // UTILITY CORE (user report 2026-09-05): summarization/merge là tác vụ chưng cất
    // nền — dùng lõi utility (zen space-bunny-free), không đụng lõi agent.
    const result = await callUtilityLLM(prompt, undefined, 'memory-summarization', {
      temperature: 0.2, // low temperature for faithful summary
      maxTokens: 300,    // summary is short
    })

    if (!result.content || !result.content.trim()) {
      return null
    }

    const summary = result.content.trim()

    // Sanity check: summary shouldn't be longer than total input
    const totalInput = batch.join(' ').length
    if (summary.length > totalInput) {
      console.warn('[Summarization] Summary longer than input — keeping input instead')
      return batch[0] // return first memory as fallback
    }

    // Sanity check: summary shouldn't be empty or just punctuation
    if (summary.length < 10 || !/[a-zA-ZÀ-ÿ\u4e00-\u9fff]/.test(summary)) {
      return null
    }

    // ===== P3-M4 — ROUGE-L RECALL GATE (ML.pdf §ROUGE — độ đo rẻ, 0 LLM) =====
    // Đo phủ nội dung nguồn qua UNION MẪU ĐẠI DIỆN (spec §P3-M4: "union mẫu
    // đại diện"): batch[0] + batch[CUỐI] — 2 mốc neo chủ đề đầu/cuối nhóm.
    // KHÔNG dùng join TOÀN BỘ mẫu: nhóm n mẫu tương tự → union ~n× chiều dài
    // → recall bị chặn cấu trúc ≤ 1/n (đo thực tế: summary NGUYÊN VĂN con của
    // mẫu 1 trong nhóm 3 chỉ đạt 0.27 — gate sẽ fallback oan mọi batch ≥3).
    // Với 2 mốc: summary giữ chủ đề đạt recall ~0.4-0.9; summary chệch chủ đề
    // (hallucinate/đổi hướng) rớt ngưỡng 0.3 → fallback batch[0] (đường sẵn có
    // — precedent sanity-check "longer than input") + log + KPI.
    const unionContent = batch.length >= 2 ? `${batch[0]} ${batch[batch.length - 1]}` : batch[0]
    const recall = rougeL(unionContent, summary).recall
    if (recall < SUMMARY_ROUGE_RECALL_MIN) {
      console.warn(
        `[Summarization] digest-gate-fallback: ROUGE-L recall=${recall.toFixed(2)} < ${SUMMARY_ROUGE_RECALL_MIN} ` +
        `(union ${batch.length} mẫu ${unionContent.length} chars → summary ${summary.length} chars) — summary mất chủ đề nguồn → giữ mẫu đầu`,
      )
      recordDigestGateEvent({ kind: 'summarization', outcome: 'fallback', rougeRecall: recall, method: 'fallback-first' })
      return batch[0] // return first memory as fallback (đường sẵn có)
    }
    recordDigestGateEvent({ kind: 'summarization', outcome: 'pass', rougeRecall: recall, method: 'llm' })

    return summary
  } catch (err) {
    console.warn('[Summarization] LLM call failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ==================== DEDUP MERGE ====================

/**
 * Merge two similar memories into one, preserving unique information from both.
 *
 * Used by storeMemory() when vector similarity > 0.92 (very similar).
 * Instead of skipping the duplicate, we merge + bump importance.
 *
 * @param existingContent The existing memory content
 * @param newContent The new (similar) memory content
 * @returns Merged content, or null if merge failed
 */
export async function mergeSimilarMemories(
  existingContent: string,
  newContent: string
): Promise<string | null> {
  // Quick path: if identical (case-insensitive), keep existing
  if (existingContent.toLowerCase().trim() === newContent.toLowerCase().trim()) {
    return existingContent
  }

  const prompt = `You are a memory merge system. Two similar memory entries need to be merged into one, preserving unique information from both.

EXISTING MEMORY:
${existingContent.slice(0, 500)}

NEW MEMORY (similar to existing):
${newContent.slice(0, 500)}

INSTRUCTIONS:
1. Merge into a SINGLE statement that captures all unique information.
2. If they conflict, prefer the NEW memory (more recent information).
3. Note "confirmed" or "updated" if the new memory validates/updates the existing one.
4. Be CONCISE — under 300 characters if possible.
5. Same language as source memories.
6. Output ONLY the merged statement, no explanation.

Merged:`

  try {
    const result = await callUtilityLLM(prompt, undefined, 'memory-merge', {
      temperature: 0.2,
      maxTokens: 200,
    })

    if (!result.content || !result.content.trim()) {
      return null
    }

    const merged = result.content.trim()

    // Sanity check
    if (merged.length < 10) return null

    return merged
  } catch (err) {
    console.warn('[Merge] LLM call failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ==================== BATCH SUMMARIZE (for scheduled jobs) ====================

/**
 * Find groups of similar memories across an agent's entire memory store
 * and summarize each group.
 *
 * This is more aggressive than archiveColdMemories() — it operates on
 * ALL active memories (not just decayed ones).
 *
 * Use case: scheduled cleanup job (e.g., daily) to compress the WARM tier.
 *
 * @returns Number of memories compressed
 */
export async function compressSimilarMemories(agentId: string): Promise<{
  compressed: number
  errors: string[]
}> {
  // This requires:
  //   1. Get all active memories for agent
  //   2. Cluster by similarity (via Qdrant vector search)
  //   3. For each cluster with > 1 memory, summarize + replace

  // Implementation deferred — Phase 5 future enhancement
  // For now, compression only happens at archive time (WARM → COLD)

  return { compressed: 0, errors: ['compressSimilarMemories not yet implemented — use archiveColdMemories instead'] }
}
