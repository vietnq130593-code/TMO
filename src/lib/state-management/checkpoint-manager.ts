/**
 * Layer 6.3: Checkpoint & Recovery
 *
 * Lưu checkpoint tại critical points để có thể restore nếu fail.
 * Checkpoint được lưu vào DB (CodeTeamCheckpoint model).
 */

import type {
  CheckpointManager,
  Checkpoint,
  CheckpointState,
  CheckpointPhase,
  ProgressState,
} from './types'
import type { PipelineStep } from '@/lib/code-team/types'
import type { RoutingDecision } from '@/lib/code-team/worklog'
import { db } from '@/lib/db'

// ==================== PRISMA DELEGATE (CodeTeamCheckpoint) ====================
// ROUND-38 fix B1: model CodeTeamCheckpoint đã được khai báo trong
// prisma/schema.prisma + db push (trước đây model thiếu → delegate undefined →
// mọi saveCheckpoint throw và bị caller nuốt im lặng — không row nào bao giờ
// được ghi). Dùng delegate THẬT của PrismaClient — hết cast + hết shape tự mô tả.

// ==================== HELPER FUNCTIONS ====================

/**
 * Xác định phase từ pipeline position.
 */
function determinePhase(pipeline: PipelineStep[], currentStepIndex: number): CheckpointPhase {
  if (currentStepIndex >= pipeline.length) return 'after_g3_optimize'

  const step = pipeline[currentStepIndex]
  if (!step) return 'before_risky_change'

  const position = step.position
  const stepType = step.step

  if (position === 'TL' && stepType === 'analyze') return 'after_tl_analyze'
  if (position === 'G1' && stepType === 'design') return 'after_g1_design'
  if (position === 'G2-A' && stepType === 'code') return 'after_g2a_code'
  if (position === 'G2-B' && stepType === 'review') return 'after_g2b_review'
  if (position === 'G3' && stepType === 'optimize') return 'after_g3_optimize'

  return 'before_risky_change'
}

/**
 * Parse JSON string với error handling.
 */
function safeJsonParse<T>(json: string, defaultValue: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return defaultValue
  }
}

// ==================== FACTORY ====================

/**
 * Tạo CheckpointManager cho một session.
 *
 * @param sessionId - ID của workflow session
 * @returns CheckpointManager instance
 */
export function createCheckpointManager(sessionId: string): CheckpointManager {
  // ==================== PUBLIC API ====================

  return {
    shouldCreateCheckpoint(step: PipelineStep, progress: ProgressState): boolean {
      // Rule 1: Sau khi hoàn thành một phase (step.isCheckpoint = true)
      if (step.isCheckpoint) return true

      // Rule 2: Trước khi thực hiện thay đổi rủi ro (G2-A code)
      if (step.step === 'code' && step.position === 'G2-A') return true

      // Rule 3: Sau khi fix xong một lỗi quan trọng
      if (
        progress.errors.length > 0 &&
        progress.errors[progress.errors.length - 1].severity === 'critical'
      ) {
        return true
      }

      // Rule 4: Khi context window sắp đầy (> 90%)
      // (Nén context giờ dùng module dùng chung @/lib/context-compression —
      // rolling digest trong workflow-engine, CI-3 B1; context-manager stub đã xóa)
      // ROUND-46 review-fix: budget ≤ 0 (KHÔNG giới hạn — thiết kế gốc) →
      // ratio vô nghĩa (used/0 = Infinity) → trước đây đánh lừng mọi step
      // đều "sắp đầy" → checkpoint mỗi step. Budget=0 → Rule 4 tắt.
      const tokenRatio = progress.totalTokensBudgeted > 0
        ? progress.totalTokensUsed / progress.totalTokensBudgeted
        : 0
      if (tokenRatio > 0.9) return true

      return false
    },

    async saveCheckpoint(state: CheckpointState): Promise<Checkpoint> {
      const phase = determinePhase(state.pipeline, state.currentStepIndex)

      // Extract completed steps
      const completedSteps = Object.values(state.progress.steps)
        .filter(s => s.status === 'completed')
        .map(s => s.id)

      // Extract files modified
      const filesModified = Object.values(state.progress.steps)
        .flatMap(s => s.result?.filesModified || [])

      // Extract key decisions từ context
      const keyDecisions: string[] = []
      for (const entry of state.context) {
        if (entry.type === 'decision') {
          keyDecisions.push(entry.content)
        }
      }

      // Extract pending issues từ progress
      const pendingIssues = state.progress.errors
        .filter(e => !e.fixApplied)
        .map(e => `${e.severity}: ${e.message}`)

      const record = await db.codeTeamCheckpoint.create({
        data: {
          sessionId,
          phase,
          completedSteps: JSON.stringify(completedSteps),
          currentStepIndex: state.currentStepIndex,
          filesModified: JSON.stringify(filesModified),
          keyDecisions: JSON.stringify(keyDecisions),
          pendingIssues: JSON.stringify(pendingIssues),
          progressSnapshot: JSON.stringify(state.progress),
          contextSnapshot: JSON.stringify(state.context),
          routingDecision: JSON.stringify(state.routing),
        },
      })

      console.log(`[CheckpointManager] Saved checkpoint ${record.id} (phase: ${phase})`)

      return {
        id: record.id,
        sessionId: record.sessionId,
        timestamp: record.createdAt.toISOString(),
        phase: record.phase as CheckpointPhase,
        completedSteps: safeJsonParse(record.completedSteps, []),
        currentStepIndex: record.currentStepIndex,
        filesModified: safeJsonParse(record.filesModified, []),
        keyDecisions: safeJsonParse(record.keyDecisions, []),
        pendingIssues: safeJsonParse(record.pendingIssues, []),
        progressSnapshot: record.progressSnapshot,
        contextSnapshot: record.contextSnapshot,
        routingDecision: record.routingDecision,
      }
    },

    async restoreCheckpoint(checkpointId: string): Promise<CheckpointState> {
      const record = await db.codeTeamCheckpoint.findUnique({
        where: { id: checkpointId },
      })

      if (!record) {
        throw new Error(`Checkpoint ${checkpointId} not found`)
      }

      console.log(`[CheckpointManager] Restored checkpoint ${checkpointId} (phase: ${record.phase})`)

      return {
        progress: safeJsonParse(record.progressSnapshot, {} as ProgressState),
        context: safeJsonParse(record.contextSnapshot, []),
        routing: safeJsonParse(record.routingDecision, {
          mode: 'B',
          tier: 2,
          score: 5,
          reasoning: 'Restored from checkpoint',
          parts: [],
        } as RoutingDecision),
        spec: '', // TODO: Lưu spec riêng
        pipeline: [], // TODO: Lưu pipeline riêng
        currentStepIndex: record.currentStepIndex,
      }
    },

    async listCheckpoints(): Promise<Checkpoint[]> {
      const records = await db.codeTeamCheckpoint.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
      })

      return records.map(record => ({
        id: record.id,
        sessionId: record.sessionId,
        timestamp: record.createdAt.toISOString(),
        phase: record.phase as CheckpointPhase,
        completedSteps: safeJsonParse(record.completedSteps, []),
        currentStepIndex: record.currentStepIndex,
        filesModified: safeJsonParse(record.filesModified, []),
        keyDecisions: safeJsonParse(record.keyDecisions, []),
        pendingIssues: safeJsonParse(record.pendingIssues, []),
        progressSnapshot: record.progressSnapshot,
        contextSnapshot: record.contextSnapshot,
        routingDecision: record.routingDecision,
      }))
    },

    async getLatestCheckpoint(): Promise<Checkpoint | null> {
      const record = await db.codeTeamCheckpoint.findFirst({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
      })

      if (!record) return null

      return {
        id: record.id,
        sessionId: record.sessionId,
        timestamp: record.createdAt.toISOString(),
        phase: record.phase as CheckpointPhase,
        completedSteps: safeJsonParse(record.completedSteps, []),
        currentStepIndex: record.currentStepIndex,
        filesModified: safeJsonParse(record.filesModified, []),
        keyDecisions: safeJsonParse(record.keyDecisions, []),
        pendingIssues: safeJsonParse(record.pendingIssues, []),
        progressSnapshot: record.progressSnapshot,
        contextSnapshot: record.contextSnapshot,
        routingDecision: record.routingDecision,
      }
    },
  }
}