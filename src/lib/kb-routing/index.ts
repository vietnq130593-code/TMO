/**
 * Smart KB Routing — Orchestrator
 *
 * Single entry point that runs all 4 layers in sequence:
 *   1. Intent classifier (skip KB if casual)
 *   2. 2-step KB access (User KB → Model Knowledge)
 *   3. Writeback (if Step 2 supplemented Step 1)
 *   4. Synthesis (combine both sources)
 *
 * Phase 4 of design doc.
 */

import { classifyIntent, type Intent, type IntentResult } from './intent-classifier'
import { accessKnowledgeBase, type KBAccessResult } from './kb-access'
import { writebackToKB, type WritebackResult } from './writeback'
import { synthesizeAnswer, type SynthesisResult } from './synthesis'

// ==================== TYPES ====================

export interface SmartKBResult {
  intent: IntentResult
  kbAccess: KBAccessResult | null  // null if intent = casual (skipped KB)
  writeback: WritebackResult | null  // null if KB was skipped
  synthesis: SynthesisResult | null  // null if KB was skipped (then return casual response)
  totalDurationMs: number
}

// ==================== MAIN ENTRY ====================

/**
 * Run the full Smart KB Routing pipeline for a user message.
 *
 * Returns:
 *   - For 'casual' intent: skips KB, returns intent only (caller handles response)
 *   - For 'factual' intent: runs all 4 layers, returns synthesis
 *   - For 'procedural' intent: returns intent (caller routes to Code Team)
 *   - For 'meta' intent: returns intent (caller uses AgentProfile)
 *
 * BRAIN-D1 note (FB-D1-R1-07, 2026-10-17): hiện CHƯA có caller production
 * nào của runSmartKB trong repo (grep toàn src = 0) — instrumentation ALS
 * intent phía dưới sẵn sàng khi được dùng; giữ nguyên làm API public.
 */
export async function runSmartKB(params: {
  message: string
  agentId?: string
  agentName?: string
  sessionId?: string
}): Promise<SmartKBResult> {
  const { message, agentId, agentName, sessionId } = params
  const startTime = Date.now()

  // === LAYER 1: Intent classification ===
  const intent = await classifyIntent(message)
  console.log(`[SmartKB] Intent: ${intent.intent} (confidence: ${intent.confidence.toFixed(2)}, source: ${intent.source})`)

  // Casual/meta/procedural → skip KB (caller handles)
  if (intent.intent !== 'factual') {
    return {
      intent,
      kbAccess: null,
      writeback: null,
      synthesis: null,
      totalDurationMs: Date.now() - startTime,
    }
  }

  // === LAYER 2: 2-step KB access (factual only) ===
  // BRAIN-D1 (task R20) — bọc ALS consult-context: intent đã classify ở
  // LAYER 1 truyền xuống KbConsultLog (accessKnowledgeBase → searchUserKB
  // đọc ngữ cảnh). LOG-ONLY fail-open — pipeline không đổi.
  const { runWithKbConsultContext } = await import('@/lib/kb-routing/consult-context')
  const kbAccess = await runWithKbConsultContext(
    {
      taskType: 'smart-kb',
      intent: intent.intent,
      sessionId: sessionId || undefined,
      agentId: agentId || undefined,
    },
    () => accessKnowledgeBase(message, agentId)
  )

  // === LAYER 3: Writeback (only if Step 2 was used) ===
  const writeback = await writebackToKB({
    query: message,
    step2Result: kbAccess.step2,
    step1Result: kbAccess.step1,
    agentId,
    agentName,
    sessionId,
  })

  if (!writeback.skipped) {
    console.log(`[SmartKB] Writeback: ${writeback.entitiesWritten} entities, ${writeback.relationshipsWritten} relationships, ${writeback.chunksWritten} chunks, memory=${writeback.memoryStored}`)
  }

  // === LAYER 4: Synthesis ===
  const synthesis = await synthesizeAnswer({
    query: message,
    step1: kbAccess.step1,
    step2: kbAccess.step2,
    agentId,
    agentName,
  })

  const totalDurationMs = Date.now() - startTime
  console.log(`[SmartKB] Total: ${totalDurationMs}ms | Intent: ${intent.intent} | Step1 conf: ${kbAccess.step1.confidence.toFixed(2)} | Step2 used: ${kbAccess.step2.used} | Writeback: ${writeback.skipped ? 'skipped' : 'done'} | Synthesis: ${synthesis.sourcesUsed.userKB ? 'UserKB' : ''}${synthesis.sourcesUsed.userKB && synthesis.sourcesUsed.modelKnowledge ? '+' : ''}${synthesis.sourcesUsed.modelKnowledge ? 'Model' : ''}`)

  return {
    intent,
    kbAccess,
    writeback,
    synthesis,
    totalDurationMs,
  }
}

// ==================== EXPORTS ====================

export type { Intent, IntentResult } from './intent-classifier'
export type { UserKBResult, ModelKnowledgeResult, KBAccessResult } from './kb-access'
export type { WritebackResult } from './writeback'
export type { SynthesisResult } from './synthesis'
export { CONFIDENCE_THRESHOLD } from './kb-access'
export { WRITEBACK_CONFIDENCE_THRESHOLD } from './writeback'
// Re-export functions for direct import from '@/lib/kb-routing'
export { classifyIntent, shouldSkipKB } from './intent-classifier'
export { accessKnowledgeBase, searchUserKB, searchModelKnowledge } from './kb-access'
export { writebackToKB } from './writeback'
export { synthesizeAnswer } from './synthesis'
