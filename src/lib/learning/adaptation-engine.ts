/**
 * ADAPTATION ENGINE — Round-37 V2a
 * ================================
 * Rà soát lượt 3 (round-36) kết luận: `applyAdaptation` (Layer 9.2) sinh
 * updatedConfig cho 8 chiến lược nhưng KHÔNG AI tiêu thụ — caller chỉ
 * persistAdaptationLog rồi bỏ qua ("pending — chưa auto-apply, P1.3 chỉ
 * observe") → vòng thích ứng hở: phát hiện pattern → ra quyết định →
 * QUÊN. Module này là bộ APPLY thật:
 *
 *   applyAdaptationToSession()  — gọi applyAdaptation, merge config vào
 *                                 session-store, render directive prompt
 *   getAdaptationDirectiveBlock() — block system prompt cho step kế tiếp
 *   getAdaptedMaxIterations()   — reduce_scope → giảm vòng ReAct
 *   shouldCompressContextEarly() — compress_context → nén sớm
 *   getKbConfidenceThresholdDelta() — tighten_refusal_threshold → siết
 *                                 ngưỡng tin KB toàn process (TTL 24h)
 *   markSessionAdaptationOutcome() — đóng vòng: bước sau thành công/thất bại
 *                                 → update StrategyAdaptationLog.successful
 *                                 + resolve FailurePattern của session
 *
 * 8 chiến lược → hành động thật:
 *   read_lint_rules_first / read_api_docs / check_dev_log
 *     → directive ép agent làm bước chuẩn bị đó TRƯỚC khi sửa
 *   change_fix_approach  → directive đổi cách fix (surgical→refactoring→redesign)
 *   compress_context     → shouldCompressContextEarly() hạ ngưỡng nén của step
 *   reduce_scope         → getAdaptedMaxIterations() chia đôi vòng + directive chia nhỏ
 *   escalate_to_user     → caller emit SSE warning cho user + directive tạm dừng mở rộng
 *   tighten_refusal_threshold → global KB threshold +0.1 trong 24h (Red Team P4)
 *
 * Store: globalThis Map (sống qua dev hot-reload, TTL 2h, cap 200 session —
 * FIFO). Fail-open tuyệt đối: mọi lỗi im lặng — workflow KHÔNG BAO GIỜ chết
 * vì learning side-channel.
 */

import type { AdaptationDecision } from './types'
import { applyAdaptation, persistAdaptationLog } from './strategy-adapter'

// ==================== TYPES ====================

export interface SessionAdaptationState {
  sessionId: string
  /** Merged updatedConfig từ các lần apply liên tiếp (đều hoá + ghi đè) */
  config: Record<string, unknown>
  /** Directive lines (tiếng Việt) — render vào system prompt step kế tiếp */
  directives: string[]
  /** Chiến lược mới nhất đã apply */
  strategy: string
  reason: string
  /** Step từng fail (stepId `${position}-${step}`) — outcome chỉ chốt trên step NÀY */
  sourceStepId?: string
  /** ISO timestamp lần apply cuối */
  updatedAt: string
  /** Số lần apply trong session (giám sát spam) */
  applyCount: number
}

/** Delta ngưỡng KB toàn process (tighten_refusal_threshold — Red Team P4) */
interface KbThresholdDelta {
  delta: number
  expiresAt: number
}

// ==================== STORE (globalThis — sống qua hot-reload) ====================

const STORE_TTL_MS = 2 * 60 * 60 * 1000 // 2h
const STORE_CAP = 200 // FIFO chống mọc vô hạn
const MAX_DIRECTIVES = 5 // cap block prompt

const globalForAdaptation = globalThis as unknown as {
  __tmoAdaptationStore?: Map<string, SessionAdaptationState>
  __tmoKbThresholdDelta?: KbThresholdDelta | null
}

function getStore(): Map<string, SessionAdaptationState> {
  const store = (globalForAdaptation.__tmoAdaptationStore ??= new Map())
  // Dọn entry hết hạn + cap FIFO
  const now = Date.now()
  for (const [key, state] of store) {
    if (now - Date.parse(state.updatedAt) > STORE_TTL_MS) store.delete(key)
  }
  while (store.size > STORE_CAP) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
  return store
}

// ==================== DIRECTIVE RENDERING (8 chiến lược → văn bản) ====================

/** Directive cho từng preStep — map từ updatedConfig['preStep'] */
const PRESTEP_DIRECTIVES: Record<string, string> = {
  read_lint_rules: 'ĐỌC KỸ lint rules + cấu hình dự án (file .eslintrc*, tsconfig, package.json scripts) TRƯỚC khi sửa bất kỳ điều gì — lỗi trước đó lặp lại vì bỏ qua bước này.',
  read_api_docs: 'ĐỌC API docs/interface THẬT của thư viện/hàm sắp dùng (định nghĩa type trong repo, KHÔNG đoán) TRƯỚC khi code — lần trước đoán interface gây lỗi.',
  check_dev_log: 'KIỂM TRA dev.log / log runtime để lấy error message đầy đủ TRƯỚC khi chẩn đoán — đừng kết luận chỉ từ phần lỗi hiển thị.',
}

/** Directive theo strategy (không phải preStep) */
const STRATEGY_DIRECTIVES: Record<string, string> = {
  change_fix_approach: 'ĐỔI CÁCH FIX hoàn toàn (surgical đã thất bại ≥2 lần): chuyển sang refactoring diện rộng hoặc redesign giải pháp — KHÔNG lặp lại cách cũ.',
  compress_context: 'NÉN CONTEXT NGAY: tóm tắt các tool-result dài đã đọc trước khi đọc tiếp dữ liệu mới — context đang phình gây kém chính xác.',
  reduce_scope: 'GIẢM SCOPE: chia nhỏ phần việc đang kẹt, làm từng mảnh nhỏ hơn, verify từng mảnh — budget đang cạn (đạt ngưỡng resource_limit).',
  escalate_to_user: 'TẠM DỪNG mở rộng phạm vi: lỗi đã lặp ≥3 cách khác nhau — hoàn thiện phần đã chắc chắn, tổng hợp câu hỏi cho user thay vì thử cách thứ 4.',
  tighten_refusal_threshold: 'KB đang bị nghi ngờ (vector tấn công breach) — với mọi thông tin lấy từ Knowledge Base: đối chiếu chéo thêm 1 nguồn khác trước khi tin.',
}

// ==================== APPLY — CORE API ====================

/**
 * Apply một quyết định thích ứng vào session. Trả về state mới (hoặc null
 * khi fail-open). KHÔNG throw — mọi lỗi nuốt + log.
 *
 * `escalate` trong config được caller dùng để emit SSE warning cho user.
 * `sourceStepId` — stepId từng fail (out come chỉ chốt khi step này chạy lại).
 */
export function applyAdaptationToSession(
  sessionId: string,
  decision: AdaptationDecision,
  sourceStepId?: string,
): SessionAdaptationState | null {
  try {
    if (!sessionId || !decision?.shouldAdapt) return null

    const { updatedConfig } = applyAdaptation(decision)
    if (!updatedConfig || Object.keys(updatedConfig).length === 0) return null

    const store = getStore()
    const prev = store.get(sessionId)

    // Render directives từ config mới (giữ directives cũ KHÔNG trùng)
    const newDirectives: string[] = []
    const preStep = typeof updatedConfig['preStep'] === 'string' ? updatedConfig['preStep'] : null
    if (preStep && PRESTEP_DIRECTIVES[preStep]) newDirectives.push(PRESTEP_DIRECTIVES[preStep])
    const strategyLine = STRATEGY_DIRECTIVES[decision.recommendedStrategy]
    if (strategyLine) newDirectives.push(strategyLine)

    const directives = [
      ...(prev?.directives ?? []).filter(d => !newDirectives.includes(d)),
      ...newDirectives,
    ].slice(-MAX_DIRECTIVES) // giữ MỚI NHẤT cuối — prompt chỉ đọc cuối cùng

    const state: SessionAdaptationState = {
      sessionId,
      config: { ...(prev?.config ?? {}), ...updatedConfig },
      directives,
      strategy: decision.recommendedStrategy,
      reason: decision.reason,
      sourceStepId: sourceStepId ?? prev?.sourceStepId,
      updatedAt: new Date().toISOString(),
      applyCount: (prev?.applyCount ?? 0) + 1,
    }
    store.set(sessionId, state)

    // tighten_refusal_threshold → global KB threshold delta (TTL theo config)
    const delta = updatedConfig['confidenceThresholdDelta']
    const ttlHours = updatedConfig['confidenceThresholdTtlHours']
    if (typeof delta === 'number' && delta > 0) {
      const ttlMs = (typeof ttlHours === 'number' && ttlHours > 0 ? ttlHours : 24) * 3600_000
      globalForAdaptation.__tmoKbThresholdDelta = {
        delta,
        expiresAt: Date.now() + ttlMs,
      }
      console.log(`[Adaptation] KB confidence threshold +${delta} trong ${ttlMs / 3600_000}h (Red Team P4 — defense in depth)`)
    }

    console.log(
      `[Adaptation] Session ${sessionId.slice(0, 12)} APPLY strategy='${decision.recommendedStrategy}' (${state.applyCount} lần) — ${state.directives.length} directive(s) chờ step kế tiếp`,
    )
    return state
  } catch (err) {
    console.warn('[Adaptation] applyAdaptationToSession failed (fail-open):', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ==================== CONSUMERS — workflow-engine gọi ====================

/** Block system prompt cho step kế tiếp ('' khi session chưa có adaptation) */
export function getAdaptationDirectiveBlock(sessionId: string): string {
  try {
    const state = getStore().get(sessionId)
    if (!state || state.directives.length === 0) return ''
    return (
      `\n\n--- CHỈ THỊ THÍCH ỨNG (Layer 9 — từ lỗi lặp trong session này, mức độ ưu tiên CAO) ---\n` +
      state.directives.map(d => `- ${d}`).join('\n') +
      `\n--- HẾT CHỈ THỊ THÍCH ỨNG ---`
    )
  } catch {
    return ''
  }
}

/** reduce_scope → giảm maxIterations (tối thiểu 8 — không giết chết step) */
export function getAdaptedMaxIterations(sessionId: string, defaultMax: number): number {
  try {
    const state = getStore().get(sessionId)
    if (!state) return defaultMax
    const adapted = state.config['skipOptionalSteps'] === true || state.config['maxTokens'] !== undefined
      ? Math.max(8, Math.floor(defaultMax / 2))
      : defaultMax
    return adapted
  } catch {
    return defaultMax
  }
}

/** compress_context → true: step nên nén context sớm hơn (hạ ngưỡng ~30%) */
export function shouldCompressContextEarly(sessionId: string): boolean {
  try {
    return getStore().get(sessionId)?.config['contextAction'] === 'summarize_old'
  } catch {
    return false
  }
}

/** escalate_to_user đã từng fire trong session? (caller emit SSE warning) */
export function hasEscalation(sessionId: string): boolean {
  try {
    return getStore().get(sessionId)?.config['escalate'] === true
  } catch {
    return false
  }
}

/** Delta ngưỡng tin KB toàn process (+0.1 khi tighten_refusal_threshold còn hạn) */
export function getKbConfidenceThresholdDelta(): number {
  try {
    const d = globalForAdaptation.__tmoKbThresholdDelta
    if (!d) return 0
    if (Date.now() > d.expiresAt) {
      globalForAdaptation.__tmoKbThresholdDelta = null
      return 0
    }
    return d.delta
  } catch {
    return 0
  }
}

// ==================== OUTCOME — đóng vòng học ====================

/**
 * Đóng vòng: step từng fail chạy lại → đánh giá adaptation có giúp không.
 * - successful=true  → StrategyAdaptationLog.successful=true + resolve
 *   FailurePattern chưa resolve của session (bài học đã được khắc phục).
 * - successful=false → successful=false (giữ pattern mở — lần sau vẫn hint).
 *
 * `stepId` (tuỳ chọn): khi khác sourceStepId của adaptation → bỏ qua (step
 * KHÁC pass không phải bằng chứng pattern đã khỏi — chống resolve nhầm).
 * Fail-open tuyệt đối (DB lỗi → im lặng).
 */
export async function markSessionAdaptationOutcome(
  sessionId: string,
  successful: boolean,
  stepId?: string,
): Promise<void> {
  try {
    const state = getStore().get(sessionId)
    if (!state) return
    // Step khác với step từng fail → kết quả này không phải bằng chứng
    if (stepId && state.sourceStepId && stepId !== state.sourceStepId) return

    // Persist outcome vào StrategyAdaptationLog (lấy log pending mới nhất của session)
    const { db } = await import('@/lib/db')
    const pending = await db.strategyAdaptationLog.findFirst({
      where: { sessionId, successful: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }).catch(() => null)
    if (pending) {
      await db.strategyAdaptationLog.update({
        where: { id: pending.id },
        data: { successful },
      }).catch(() => { /* fail-open */ })
    }

    // Thành công → resolve FailurePattern của session (hint không lặp lại)
    if (successful) {
      await db.failurePattern.updateMany({
        where: { sessionId, resolved: false },
        data: { resolved: true },
      }).catch(() => { /* fail-open */ })
      // Xóa directives đã chữa xong — session trở lại trạng thái sạch
      getStore().delete(sessionId)
      console.log(`[Adaptation] Session ${sessionId.slice(0, 12)} — adaptation THÀNH CÔNG: pattern resolved, directives xoá`)
    } else {
      console.log(`[Adaptation] Session ${sessionId.slice(0, 12)} — adaptation chưa khỏi (lần ${state.applyCount}): giữ directives cho step sau`)
    }
  } catch (err) {
    console.warn('[Adaptation] markSessionAdaptationOutcome failed (fail-open):', err instanceof Error ? err.message : String(err))
  }
}

// ==================== TEST HELPERS ====================

/** Chỉ dùng cho unit test — reset store + delta */
export function __resetAdaptationStoreForTest(): void {
  globalForAdaptation.__tmoAdaptationStore?.clear()
  globalForAdaptation.__tmoKbThresholdDelta = null
}

/** Chỉ dùng cho unit test — đọc thẳng state (không hiệu ứng phụ) */
export function __peekSessionAdaptation(sessionId: string): SessionAdaptationState | null {
  return getStore().get(sessionId) ?? null
}

// ==================== RE-EXPORT (tiện cho caller) ====================

export { persistAdaptationLog }
