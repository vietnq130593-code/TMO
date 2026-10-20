/**
 * RESEARCH TEAM — MODEL OVERRIDE CONTEXT (FIX TEAM-MODEL-1, 2026-10-20)
 * ============================================================
 * User report: "khi đổi sang chọn team thì không thể chọn model như khi chọn
 * agent độc lập mà chỉ có model thiết lập sẵn". Code Team wire override qua
 * WorkflowConfig (route → engine); Research Team resolve brain rải rác ở 15
 * file (king/engine, councils, tournament, g1/g2/g3...) — thay vì sửa 15 call
 * site, dùng AsyncLocalStorage: route wrap TOÀN BỘ flow trong 1 context, mọi
 * resolveResearchBrain() bên trong tự thấy override (fail-open: không có
 * context / context rỗng → DB AgentProfile như cũ).
 *
 * Pure module — KHÔNG import db/llm (test được độc lập).
 * Context sống theo async-flow: mọi await/then bên trong callback kế thừa —
 * workflow chạy tiếp nền (continueOnDisconnect) vẫn giữ override.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ResearchModelOverride {
  model: string
  provider: string
}

const storage = new AsyncLocalStorage<ResearchModelOverride>()

/**
 * Chạy `fn` trong context có model override — mọi resolveResearchBrain() trong
 * call-graph của fn (bao gồm các await/then phát sinh tiếp) trả về override này.
 * Trả nguyên giá trị fn trả về (transparent).
 */
export function withResearchModelOverride<T>(override: ResearchModelOverride, fn: () => Promise<T>): Promise<T> {
  return storage.run(override, fn)
}

/** Override đang hoạt động của async-flow hiện tại — undefined khi không có. */
export function currentResearchModelOverride(): ResearchModelOverride | undefined {
  return storage.getStore()
}
