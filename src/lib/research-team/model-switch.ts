/**
 * RESEARCH TEAM — MODEL SWITCH (DR-C7 + TB-01 §2)
 * =================================================
 * Spec: TB-01 §2 (fallback chain — hành vi runtime) · TB-01 §7 Q2 (format chuẩn
 * DR-C7) · TB-13 §4 (format: `model switched: <from> → <to> | trigger: <lý do> |
 * next check: <thời điểm>`) · TB-09 §4.3 (dòng Model note trong worklog).
 *
 * Bất biến (TB-01 §2):
 * - Chuyển bậc KHÔNG phải pivot: research direction, hypothesis, tier giữ nguyên.
 * - Agent GIỮ NGUYÊN vai trò + JD — chỉ "bộ não" đổi.
 * - Mỗi task mới khởi động lại từ model chính (bậc 0).
 * - Cả stack lỗi → task BLOCKED, KING báo user (đó là mission-store/king's job,
 *   không nằm ở file này).
 */

import { db } from '@/lib/db'
import { AGENT_FALLBACK_CHAIN, AGENT_PRIMARY_MODEL } from '@/lib/llm'
import { encodeJson } from './types'
import type { ModelSwitchEntry } from './types'
import type { AgentId } from './constants'

/**
 * Stack đầy đủ theo thứ tự bậc (TB-01 §2):
 * bậc 0 = model chính (SSOT: AGENT_PRIMARY_MODEL từ llm.ts),
 * bậc 1–3 = fallback chain (SSOT: AGENT_FALLBACK_CHAIN từ llm.ts).
 */
export function getModelStack(): string[] {
  return [AGENT_PRIMARY_MODEL, ...AGENT_FALLBACK_CHAIN]
}

/** Bậc của model trong stack; -1 nếu không thuộc stack */
export function getModelRank(model: string): number {
  const stack = getModelStack()
  const idx = stack.indexOf(model)
  return idx
}

/** Model fallback kế tiếp sau `fromModel`; null nếu đã bậc terminal (→ BLOCKED) */
export function nextFallbackModel(fromModel: string): string | null {
  const rank = getModelRank(fromModel)
  if (rank < 0) return getModelStack()[1] ?? null
  const next = getModelStack()[rank + 1]
  return next ?? null // bậc 3 (terminal) → null → caller đánh dấu BLOCKED
}

/**
 * Sinh dòng worklog format chuẩn DR-C7:
 * `model switched: <from> → <to> | trigger: <lý do> | next check: <thời điểm>`
 */
export function formatModelSwitchLine(params: {
  fromModel: string
  toModel: string
  trigger: string
  nextCheck: string
}): string {
  return `model switched: ${params.fromModel} → ${params.toModel} | trigger: ${params.trigger} | next check: ${params.nextCheck}`
}

/**
 * Ghi sự kiện chuyển model:
 * (1) persist ModelSwitchEvent (Prisma — evidence vĩnh viễn) +
 * (2) trả về ModelSwitchEntry để caller nhét vào worklog modelSwitchedJson
 *     (thứ tự TB-01 §5: dòng model switched ghi TRƯỚC phần kết quả).
 *
 * KHÔNG reset task, KHÔNG đổi quyền — role-based (TB-09 §4.3).
 */
export async function recordModelSwitch(params: {
  agentId: AgentId | string
  fromModel: string
  toModel: string
  trigger: string
  nextCheck: string
}): Promise<ModelSwitchEntry> {
  const at = new Date().toISOString()
  const worklogLine = formatModelSwitchLine(params)

  try {
    await db.modelSwitchEvent.create({
      data: {
        agentId: params.agentId,
        fromModel: params.fromModel,
        toModel: params.toModel,
        trigger: params.trigger,
        nextCheck: params.nextCheck,
      },
    })
  } catch (err) {
    // Persist lỗi KHÔNG chặn pipeline — entry vẫn trả về để worklog giữ dấu vết
    console.warn(
      '[ResearchTeam/model-switch] Persist ModelSwitchEvent failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
  }

  return {
    at,
    fromModel: params.fromModel,
    toModel: params.toModel,
    trigger: params.trigger,
    nextCheck: params.nextCheck,
    worklogLine,
  }
}

/** Encode mảng entries → chuỗi JSON cho cột modelSwitchedJson (helper tiện dụng) */
export function encodeModelSwitchedEntries(entries: ModelSwitchEntry[]): string {
  return encodeJson(entries)
}
