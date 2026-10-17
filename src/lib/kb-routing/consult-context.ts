/**
 * BRAIN-D1 (BLUEPRINT-EVO-NAO-P1-P5 §8.1 — task R20) — KB CONSULT CONTEXT
 * ============================================================================
 *
 * Ngữ cảnh consult truyền từ CALLER xuống tầng ghi log KbConsultLog bằng
 * AsyncLocalStorage — KHÔNG đổi signature searchUserKB/accessKnowledgeBase
 * (mọi caller hiện tại giữ nguyên; caller có ngữ cảnh bọc lại bằng
 * runWithKbConsultContext, caller không bọc → log vẫn ghi với field ngữ
 * cảnh null — LOG-ONLY không bắt buộc).
 *
 * Luồng:
 *   caller (chat route / executeTool / runSmartKB)
 *     └─ runWithKbConsultContext({taskType, intent, runId, sessionId, agentId}, fn)
 *          └─ … (bất kỳ chiều sâu async nào …)
 *               └─ searchUserKB → logKbConsult đọc getKbConsultContext()
 *
 * Thiết kế:
 * - MERGE SHALLOW khi lồng nhau (con thắng cha theo key): chat route bọc
 *   'chat' → bên trong executeTool bọc 'tool:knowledge_search' → log thấy
 *   đúng ngữ cảnh GẦN NHẤT (tool), giữ runId/sessionId từ cha nếu con không
 *   chỉ định lại.
 * - FAIL-OPEN tuyệt đối: module này KHÔNG BAO GIỜ throw — ALS lỗi → trả {}
 *   (log vẫn ghi, thiếu field ngữ cảnh).
 * - D3 (tương lai): brain/brains/knowledge.ts policy head TÁI DÙNG chính
 *   context này cho inference đầu vào (taskType/intent/agentId) — không cần
 *   cơ chế thứ hai.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** Ngữ cảnh 1 lượt consult KB — mọi field optional (caller biết gì truyền nấy). */
export interface KbConsultContext {
  /** 'chat' | 'tool:knowledge_search' | 'code-team-workflow' | 'eval' | 'redteam'… */
  taskType?: string
  /** Nhãn intent-classifier: casual | meta | procedural | factual */
  intent?: string
  /** AgentRunRecord.id — nối Outcome* (tín hiệu reward D3) */
  runId?: string
  /** Phiên chat/session */
  sessionId?: string
  /** Agent profile id hoặc tên agent đang consult */
  agentId?: string
}

const als = new AsyncLocalStorage<KbConsultContext>()

/**
 * Bọc 1 đoạn async trong ngữ cảnh consult. Merge shallow với context cha
 * (nếu có) — key của CON thắng. Fail-open: ALS không khả dụng → chạy fn
 * trực tiếp (không ngữ cảnh).
 */
export function runWithKbConsultContext<T>(
  ctx: KbConsultContext,
  fn: () => Promise<T>
): Promise<T> {
  try {
    const parent = als.getStore()
    const merged: KbConsultContext = parent ? { ...parent, ...ctx } : { ...ctx }
    return als.run(merged, fn)
  } catch {
    // ALS không chạy được (edge runtime/SSR) — fail-open, không ngữ cảnh
    return fn()
  }
}

/** Đọc ngữ cảnh consult hiện tại (từ BẤT KỲ chiều sâu async bên trong wrap).
 * Trả {} khi không có wrap — LOG-ONLY không bắt buộc ngữ cảnh. */
export function getKbConsultContext(): KbConsultContext {
  try {
    return als.getStore() ?? {}
  } catch {
    return {}
  }
}
