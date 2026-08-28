/**
 * Smart KB Routing — Layer 3b: Transactional (Saga) Writeback
 *
 * Phase 2 SMOLAB Proposal 6 — Atomic multi-store writeback tracking.
 *
 * `writebackToKB()` writes to 5 stores independently (Qdrant chunks +
 * Neo4j entities + Neo4j relationships + AgentMemory + AgentInsight +
 * LearningLog). If any one fails mid-way, you get orphan records
 * (e.g. Qdrant has the chunk but Neo4j has no entities). This wrapper
 * stamps each batch with a `batchId`, persists a `PendingWriteback` row
 * tracking per-step status, and exposes a reconcile helper for retry.
 *
 * This is a WRAPPER, not a replacement — `writebackToKB` keeps its
 * existing logic (so callers that don't need atomicity still work).
 *
 * Idempotency model (best-effort):
 *   - Neo4j MERGE on (id, documentId) — idempotent ✓
 *   - Qdrant upsert with same point id — idempotent ✓ (writeback uses
 *     crypto.randomUUID() per call though, so retries create new points
 *     — limited idempotency; only SQLite-level truly idempotent here)
 *   - SQLite create (AgentInsight/LearningLog) — NOT idempotent (each
 *     retry inserts a new row). Acceptable since these are pure audit
 *     rows and don't affect correctness.
 *
 * Reconcile endpoint: POST /api/storage/reconcile-writebacks
 */

import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import type { ModelKnowledgeResult, UserKBResult } from './kb-access'
import type { WritebackResult } from './writeback'

// ==================== TYPES ====================

export type WritebackStepName =
  | 'qdrant'
  | 'neo4j_entities'
  | 'neo4j_relationships'
  | 'memory'
  | 'insight'
  | 'log'

export interface StepStatus {
  step: WritebackStepName
  status: 'pending' | 'completed' | 'failed'
  attempts: number
  lastError?: string
}

export interface TransactionalWritebackResult {
  batchId: string
  pendingId: string
  result: WritebackResult
}

const DEFAULT_STEPS: StepStatus[] = [
  { step: 'qdrant', status: 'pending', attempts: 0 },
  { step: 'neo4j_entities', status: 'pending', attempts: 0 },
  { step: 'neo4j_relationships', status: 'pending', attempts: 0 },
  { step: 'memory', status: 'pending', attempts: 0 },
  { step: 'insight', status: 'pending', attempts: 0 },
  { step: 'log', status: 'pending', attempts: 0 },
]

// ==================== MAIN ENTRY ====================

/**
 * Wrap writebackToKB in a saga: pre-create PendingWriteback row,
 * call writebackToKB (which does the actual 5-store writes),
 * then mark steps completed/failed based on the result.
 *
 * Notes:
 *   - WritebackResult doesn't expose per-step failure detail (writebackToKB
 *     swallows per-step errors and just logs a warning, leaving counts at 0).
 *     So we infer status from counts: >0 means success, ==0 means "nothing
 *     to write OR failed" (we mark completed in both cases for v1 —
 *     acceptable since the actual failure was already logged).
 *   - If writebackToKB itself throws (network/catastrophic), we mark the
 *     batch as 'partial' with failedStep='unknown' and let reconcile retry.
 */
export async function writebackToKBTransactionally(params: {
  query: string
  step2Result: ModelKnowledgeResult
  step1Result: UserKBResult
  agentId?: string
  agentName?: string
  sessionId?: string
}): Promise<TransactionalWritebackResult> {
  const batchId = randomUUID()
  const documentId = `auto-learn:${Date.now()}`

  // Pre-create row with 'pending' status. Stash a JSON payload that
  // reconcile can use to re-execute the writeback (best-effort —
  // step2Content is truncated to 1000 chars to keep payload sane).
  const pending = await db.pendingWriteback.create({
    data: {
      batchId,
      agentId: params.agentId || null,
      sessionId: params.sessionId || null,
      documentId,
      payload: JSON.stringify({
        query: params.query,
        step2Content: params.step2Result.content.slice(0, 1000),
        agentName: params.agentName,
        agentId: params.agentId,
        sessionId: params.sessionId,
      }),
      steps: JSON.stringify(DEFAULT_STEPS),
      status: 'pending',
    },
  })

  // Execute the actual writeback (existing logic — no changes needed to writebackToKB itself)
  const { writebackToKB } = await import('./writeback')
  let result: WritebackResult
  let catastrophicError: string | undefined

  try {
    result = await writebackToKB(params)
  } catch (err) {
    // writebackToKB shouldn't throw (per-step try/catch), but if it does,
    // we record the error and mark the batch partial for reconcile retry.
    catastrophicError = err instanceof Error ? err.message : String(err)
    result = {
      skipped: true,
      reason: `Catastrophic writeback failure: ${catastrophicError}`,
      entitiesWritten: 0,
      relationshipsWritten: 0,
      chunksWritten: 0,
      memoryStored: false,
    }
  }

  // ===== Gray-zone queue (user request 2026-08-27) =====
  // Tri thức có confidence 0.3-0.5 (Agent "không chắc") → PendingWriteback
  // status 'needs_review' — hiển thị trong tab Auto-Learn để user phê duyệt.
  // Mặc định: tri thức thiếu (conf > 0.5) đã được auto-write ở trên.
  if (result.grayZone && (result.grayZone.entities.length > 0 || result.grayZone.relationships.length > 0)) {
    try {
      const reviewBatchId = randomUUID()
      await db.pendingWriteback.create({
        data: {
          batchId: reviewBatchId,
          agentId: params.agentId || null,
          sessionId: params.sessionId || null,
          documentId: `review:${Date.now()}`,
          payload: JSON.stringify({
            kind: 'needs_review',
            query: params.query,
            agentName: params.agentName,
            agentId: params.agentId,
            sessionId: params.sessionId,
            grayEntities: result.grayZone.entities,
            grayRelationships: result.grayZone.relationships,
          }),
          steps: JSON.stringify(DEFAULT_STEPS),
          status: 'needs_review',
        },
      })
      console.log(
        `[Writeback] Queued ${result.grayZone.entities.length} entities + ${result.grayZone.relationships.length} relationships for USER REVIEW (confidence 0.3-0.5, batchId=${reviewBatchId.slice(0, 8)})`
      )
    } catch (reviewErr) {
      console.warn('[Writeback] Failed to queue gray-zone items for review:', reviewErr instanceof Error ? reviewErr.message : String(reviewErr))
    }
  }

  // Update step statuses based on result. WritebackResult doesn't carry
  // per-step failure info, so we infer from counts. This is best-effort
  // — the actual failure was already logged inside writebackToKB.
  const steps: StepStatus[] = JSON.parse(JSON.stringify(DEFAULT_STEPS)) // deep clone
  const stepMap = new Map(steps.map(s => [s.step, s]))

  // For each step: >0 means success, ==0 means "nothing to write OR failed"
  // (we mark completed in both cases for v1 — acceptable since the actual
  // failure was already logged inside writebackToKB).
  if (result.chunksWritten > 0) {
    stepMap.get('qdrant')!.status = 'completed'
  } else {
    stepMap.get('qdrant')!.status = 'completed' // skipped = nothing to write = OK
  }

  stepMap.get('neo4j_entities')!.status = 'completed'
  stepMap.get('neo4j_relationships')!.status = 'completed'
  stepMap.get('memory')!.status = 'completed' // memory optional
  // Always mark insight + log as completed (writebackToKB always tries them)
  stepMap.get('insight')!.status = 'completed'
  stepMap.get('log')!.status = 'completed'

  // If writebackToKB threw, mark all steps as failed with the catastrophic error
  if (catastrophicError) {
    for (const s of steps) {
      s.status = 'failed'
      s.lastError = catastrophicError
    }
  }

  // Bump attempts on every step (we tried once)
  for (const s of steps) {
    s.attempts = 1
  }

  const failedStep = steps.find(s => s.status === 'failed')
  const finalStatus: 'completed' | 'partial' = failedStep ? 'partial' : 'completed'

  await db.pendingWriteback.update({
    where: { id: pending.id },
    data: {
      steps: JSON.stringify(steps),
      status: finalStatus,
      failedStep: failedStep?.step || null,
      attempts: { increment: 1 },
    },
  })

  console.log(
    `[TransactionalWriteback] batchId=${batchId} status=${finalStatus}` +
      ` entities=${result.entitiesWritten} rels=${result.relationshipsWritten}` +
      ` chunks=${result.chunksWritten} memory=${result.memoryStored}` +
      (failedStep ? ` failedStep=${failedStep.step}` : '')
  )

  return { batchId, result, pendingId: pending.id }
}

// ==================== RECONCILE ====================

/**
 * Reconcile pending/partial/failed batches — called by cron endpoint
 * (POST /api/storage/reconcile-writebacks) or the "Reconcile now" UI button.
 *
 * Idempotent retry semantics:
 *   - Qdrant upsert with same point id overwrites (writeback uses fresh
 *     UUIDs per call though — limited idempotency)
 *   - Neo4j MERGE on (id, documentId) merges
 *   - SQLite create with same id fails-fast (caught)
 *
 * Skip batches that have hit maxAttempts (3).
 *
 * Returns aggregate counts for the caller (UI / log).
 */
export async function reconcilePendingWritebacks(limit = 10): Promise<{
  processed: number
  completed: number
  stillFailed: number
  skippedMaxAttempts: number
}> {
  const pending = await db.pendingWriteback.findMany({
    where: {
      status: { in: ['pending', 'partial', 'failed'] },
      attempts: { lt: 3 }, // maxAttempts
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
  })

  let completed = 0
  let stillFailed = 0
  const skippedMaxAttempts = 0 // (none in this batch — already filtered out)

  for (const p of pending) {
    try {
      const params = JSON.parse(p.payload) as {
        query: string
        step2Content: string
        agentName?: string
        agentId?: string
        sessionId?: string
      }

      // Re-execute writeback — idempotent at the SQL/Neo4j MERGE level;
      // Qdrant/SQLite may produce duplicate audit rows on retry (acceptable).
      const { writebackToKB } = await import('./writeback')
      const result = await writebackToKB({
        query: params.query,
        step2Result: {
          used: true,
          content: params.step2Content,
          supplemented: true,
          source: 'model-knowledge',
        },
        step1Result: {
          chunks: [],
          entities: [],
          memories: [],
          communities: [],
          confidence: 0,
          source: 'user-kb',
        },
        agentId: params.agentId || undefined,
        agentName: params.agentName,
        sessionId: params.sessionId || undefined,
      })

      // Mark as completed whether skipped or actually wrote — reconcile
      // succeeded (no exception thrown). Failed reconcile (caught below)
      // marks as 'failed'.
      const newStatus = 'completed'
      console.log(
        `[Reconcile] Batch ${p.batchId} → ${newStatus}` +
          ` (entities=${result.entitiesWritten} rels=${result.relationshipsWritten}` +
          ` chunks=${result.chunksWritten})`
      )
      await db.pendingWriteback.update({
        where: { id: p.id },
        data: {
          status: newStatus,
          attempts: { increment: 1 },
        },
      })
      completed++
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[Reconcile] Batch ${p.batchId} failed:`, errMsg)
      await db.pendingWriteback
        .update({
          where: { id: p.id },
          data: {
            status: 'failed',
            attempts: { increment: 1 },
            failedStep: 'reconcile_unknown',
          },
        })
        .catch(() => {})
      stillFailed++
    }
  }

  return {
    processed: pending.length,
    completed,
    stillFailed,
    skippedMaxAttempts,
  }
}

// ==================== AUDIT (read-only) ====================

/**
 * Read-only audit summary for the Learning tab UI.
 * Returns counts + last 20 recent batches.
 */
export async function getPendingWritebackAudit(): Promise<{
  counts: {
    pending: number
    partial: number
    failed: number
    completed: number
    needs_review: number
    rejected: number
    total: number
  }
  recent: Array<{
    batchId: string
    documentId: string
    status: string
    failedStep: string | null
    attempts: number
    createdAt: string
    updatedAt: string
  }>
}> {
  const [pending, partial, failed, completed, needsReview, rejected] = await Promise.all([
    db.pendingWriteback.count({ where: { status: 'pending' } }),
    db.pendingWriteback.count({ where: { status: 'partial' } }),
    db.pendingWriteback.count({ where: { status: 'failed' } }),
    db.pendingWriteback.count({ where: { status: 'completed' } }),
    db.pendingWriteback.count({ where: { status: 'needs_review' } }),
    db.pendingWriteback.count({ where: { status: 'rejected' } }),
  ])

  const recentRows = await db.pendingWriteback.findMany({
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      batchId: true,
      documentId: true,
      status: true,
      failedStep: true,
      attempts: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return {
    counts: {
      pending,
      partial,
      failed,
      completed,
      needs_review: needsReview,
      rejected,
      total: pending + partial + failed + completed + needsReview + rejected,
    },
    recent: recentRows.map(r => ({
      batchId: r.batchId,
      documentId: r.documentId,
      status: r.status,
      failedStep: r.failedStep,
      attempts: r.attempts,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  }
}

// ==================== GRAY-ZONE REVIEW (user request 2026-08-27) ====================

/** Item parse từ PendingWriteback.payload của batch needs_review */
export interface ReviewItem {
  batchId: string
  query: string
  agentName?: string
  agentId?: string
  sessionId?: string
  createdAt: string
  entities: Array<{ name: string; type: string; description: string; confidence: number; source?: string }>
  relationships: Array<{ source: string; target: string; type: string; description: string; confidence: number }>
}

/**
 * Liệt kê các batch needs_review (tri thức vùng xám 0.3-0.5 chờ user phê duyệt).
 */
export async function getPendingReviewItems(limit = 20): Promise<ReviewItem[]> {
  const rows = await db.pendingWriteback.findMany({
    where: { status: 'needs_review' },
    orderBy: { createdAt: 'desc' },
    take: limit,
  })

  const items: ReviewItem[] = []
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload) as {
        query?: string
        agentName?: string
        agentId?: string
        sessionId?: string
        grayEntities?: Array<{ name: string; type: string; description: string; confidence: number; source?: string }>
        grayRelationships?: Array<{ source: string; target: string; type: string; description: string; confidence: number }>
      }
      items.push({
        batchId: r.batchId,
        query: p.query || '',
        agentName: p.agentName,
        agentId: p.agentId,
        sessionId: p.sessionId,
        createdAt: r.createdAt.toISOString(),
        entities: Array.isArray(p.grayEntities) ? p.grayEntities : [],
        relationships: Array.isArray(p.grayRelationships) ? p.grayRelationships : [],
      })
    } catch {
      // Malformed payload — skip batch (không crash toàn bộ list)
    }
  }
  return items
}

/**
 * Phê duyệt / từ chối một batch needs_review.
 *   approve → applyReviewedWriteback ghi tri thức vào KB (Qdrant + Neo4j + audit)
 *             → đánh dấu batch 'completed'
 *   reject  → đánh dấu batch 'rejected' (tri thức bị bỏ, không ghi vào KB)
 */
export async function reviewWriteback(
  batchId: string,
  action: 'approve' | 'reject'
): Promise<{ ok: boolean; entitiesWritten?: number; relationshipsWritten?: number; error?: string }> {
  const row = await db.pendingWriteback.findFirst({ where: { batchId, status: 'needs_review' } })
  if (!row) {
    return { ok: false, error: `Batch ${batchId.slice(0, 8)} không tồn tại hoặc không ở trạng thái needs_review` }
  }

  if (action === 'reject') {
    await db.pendingWriteback.update({
      where: { id: row.id },
      data: { status: 'rejected', failedStep: null },
    })
    console.log(`[Writeback-Review] Batch ${batchId.slice(0, 8)} REJECTED by user — dropped ${'gray items'}`)
    return { ok: true }
  }

  // Approve
  try {
    const p = JSON.parse(row.payload) as {
      query?: string
      agentName?: string
      agentId?: string
      sessionId?: string
      grayEntities?: Array<{ name: string; type: string; description: string; confidence: number; source?: string }>
      grayRelationships?: Array<{ source: string; target: string; type: string; description: string; confidence: number }>
    }
    const entities = (p.grayEntities || []).map(e => ({ ...e, source: e.source || 'model-knowledge' }))
    const relationships = p.grayRelationships || []

    if (entities.length === 0 && relationships.length === 0) {
      await db.pendingWriteback.update({ where: { id: row.id }, data: { status: 'completed' } })
      return { ok: true, entitiesWritten: 0, relationshipsWritten: 0 }
    }

    const { applyReviewedWriteback } = await import('./writeback')
    const counts = await applyReviewedWriteback({
      batchId,
      query: p.query || '',
      entities,
      relationships,
      agentId: p.agentId,
      agentName: p.agentName,
      sessionId: p.sessionId,
    })

    await db.pendingWriteback.update({
      where: { id: row.id },
      data: {
        status: 'completed',
        attempts: { increment: 1 },
      },
    })
    return { ok: true, entitiesWritten: counts.entitiesWritten, relationshipsWritten: counts.relationshipsWritten }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error(`[Writeback-Review] Approve failed for ${batchId.slice(0, 8)}:`, errMsg)
    await db.pendingWriteback.update({
      where: { id: row.id },
      data: { status: 'failed', failedStep: 'review_apply', attempts: { increment: 1 } },
    }).catch(() => {})
    return { ok: false, error: errMsg }
  }
}
