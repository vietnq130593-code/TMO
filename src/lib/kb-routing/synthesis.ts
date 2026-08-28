/**
 * Smart KB Routing — Layer 4: Synthesis
 *
 * Combines Step 1 (User KB) + Step 2 (Model Knowledge) results,
 * marks sources clearly, and generates the final answer.
 *
 * Phase 4 of design doc.
 */

import { callLLM } from '@/lib/llm'
import type { UserKBResult, ModelKnowledgeResult } from './kb-access'

// ==================== TYPES ====================

export interface SynthesisResult {
  content: string  // final synthesized answer
  sourcesUsed: {
    userKB: boolean  // did we cite user KB content?
    modelKnowledge: boolean  // did we cite model training knowledge?
  }
  tokensUsed?: number
}

// ==================== MAIN ENTRY ====================

/**
 * Synthesize the final answer from Step 1 + Step 2 results.
 *
 * The synthesis LLM is instructed to:
 *   - Mark facts with [User KB] or [Model Knowledge] tags
 *   - Prefer User KB on conflicts (user's domain-specific data)
 *   - Cite sources so user can verify
 */
export async function synthesizeAnswer(params: {
  query: string
  step1: UserKBResult
  step2: ModelKnowledgeResult
  agentId?: string
  agentName?: string
}): Promise<SynthesisResult> {
  const { query, step1, step2, agentId, agentName } = params

  // Fast path: if Step 2 was not used, just return the Step 1 chunks directly
  // (no synthesis LLM call needed — saves tokens)
  if (!step2.used) {
    return synthesizeFromStep1Only(query, step1)
  }

  // Full synthesis: combine Step 1 + Step 2 with source marking
  const userKBContext = formatUserKB(step1)
  const modelKnowledge = step2.content

  const prompt = `You are a synthesis agent. Combine the following 2 knowledge sources into a single coherent answer.

USER QUERY:
${query}

=== SOURCE 1: USER KNOWLEDGE BASE (Step 1) ===
Confidence: ${step1.confidence.toFixed(2)}
${userKBContext || '(no relevant content found in user KB)'}

=== SOURCE 2: MODEL TRAINING KNOWLEDGE (Step 2) ===
${modelKnowledge || '(not invoked)'}

=== INSTRUCTIONS ===
1. Synthesize a single coherent answer using BOTH sources.
2. Mark every factual claim with its source:
   - [User KB] for facts from Source 1
   - [Model Knowledge] for facts from Source 2
   - If both sources agree, mark once with the more authoritative source
3. If sources CONFLICT, prefer User KB (it contains domain-specific data) and note the conflict.
4. Be concise but complete. Aim for 200-500 words unless the query needs more.
5. End with a brief "Sources used:" summary listing which sources contributed.
6. Write in the same language as the user's query.

Answer:`

  try {
    const result = await callLLM(prompt, undefined, 'synthesis', {
      temperature: 0.4,
      maxTokens: 3000,
      ...(agentId ? { agentId } : {}),
      ...(agentName ? { agentName } : {}),
    })

    return {
      content: result.content || 'I could not synthesize an answer. Please try again.',
      sourcesUsed: {
        userKB: step1.chunks.length > 0 || step1.entities.length > 0,
        modelKnowledge: step2.used,
      },
      tokensUsed: result.tokensUsed,
    }
  } catch (err) {
    console.error('[Synthesis] LLM call failed:', err instanceof Error ? err.message : String(err))
    // Fallback: return raw Step 2 content (better than nothing)
    return {
      content: step2.content || 'I could not generate an answer.',
      sourcesUsed: {
        userKB: false,
        modelKnowledge: true,
      },
    }
  }
}

/**
 * Fast path synthesis — when Step 2 was NOT invoked (Step 1 had enough info),
 * skip the synthesis LLM call and just return the most relevant chunks.
 *
 * This is a major token-saver: if user KB has high confidence,
 * we don't pay for an extra LLM call.
 */
function synthesizeFromStep1Only(query: string, step1: UserKBResult): SynthesisResult {
  if (step1.chunks.length === 0 && step1.entities.length === 0) {
    return {
      content: `I don't have enough information in the user knowledge base to answer this question. Could you rephrase or upload relevant documents?`,
      sourcesUsed: { userKB: false, modelKnowledge: false },
    }
  }

  // Build answer from chunks + entities
  const parts: string[] = []

  if (step1.chunks.length > 0) {
    parts.push('Here is what I found in the knowledge base:')
    parts.push(step1.chunks.map(c => c.text).join('\n\n'))
  }

  if (step1.entities.length > 0) {
    parts.push('\nRelated entities in knowledge graph:')
    parts.push(step1.entities.map(e => `- ${e.name} (${e.type}): ${e.description}`).join('\n'))
  }

  if (step1.memories.length > 0) {
    parts.push('\nPast memories:')
    parts.push(step1.memories.map(m => `- ${m.content}`).join('\n'))
  }

  parts.push('\nSources used: User KB only (confidence: ' + step1.confidence.toFixed(2) + ')')

  return {
    content: parts.join('\n\n'),
    sourcesUsed: { userKB: true, modelKnowledge: false },
  }
}

function formatUserKB(step1: UserKBResult): string {
  const parts: string[] = []

  if (step1.chunks.length > 0) {
    parts.push('--- Document chunks ---')
    parts.push(step1.chunks.map((c, i) =>
      `[${i + 1}] (score: ${c.score.toFixed(2)}) ${c.text.slice(0, 500)}`
    ).join('\n'))
  }

  if (step1.entities.length > 0) {
    parts.push('--- Known entities ---')
    parts.push(step1.entities.map(e =>
      `- ${e.name} (${e.type}): ${e.description.slice(0, 200)}`
    ).join('\n'))
  }

  // Leiden community context (user request 2026-09-05) — bức tranh lớn
  if (step1.communities.length > 0) {
    parts.push('--- Knowledge communities (graph clusters) ---')
    parts.push(step1.communities.map(c =>
      `[${c.score?.toFixed(2) ?? '?'}] ${c.summary.slice(0, 500)}`
    ).join('\n'))
  }

  if (step1.memories.length > 0) {
    parts.push('--- Past memories ---')
    parts.push(step1.memories.map(m =>
      `- ${m.content.slice(0, 200)}`
    ).join('\n'))
  }

  return parts.join('\n\n')
}
