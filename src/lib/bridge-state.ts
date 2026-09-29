/**
 * BRIDGE STATE — quyết định trạng thái gateway-bridge thuần (pure function)
 *
 * Tách ra khỏi src/app/api/tools/route.ts để:
 *  (1) unit test được nhánh logic (regression test)
 *  (2) tái sử dụng ở /api/tools/registry + UI mà không import route handler
 *
 * BỐI CẢNH: gateway-bridge chạy LAZY (src/lib/openclaw-ondemand.ts). Idle quá
 * OPENCLAW_IDLE_SHUTDOWN_MS thì tự tắt, được spawn lại khi agent gọi tool đầu
 * tiên (ensureBridgeRunning). Nên "bridge offline" KHÔNG đồng nghĩa "tool hỏng":
 *   - onDemand=true  + offline → đang NGỦ, vẫn gọi được (lazy spawn) → asleep
 *   - onDemand=false + offline → không có cơ chế tự bật, coi như hỏng → unavailable
 * BUG CŨ: route cũ gán 'unavailable' cho cả 2 trường hợp → /api/tools báo sai
 * 18 tool chết, accessibleTotal 85→67 dù gọi là chạy được ngay.
 */

export type BridgeAccessMode = 'bridge' | 'unavailable'
export type BridgeRunState = 'online' | 'asleep' | 'down'

export interface BridgeStateInput {
  /** bridge trả /health với bridge.authenticated === true */
  bridgeOnline: boolean
  /** OPENCLAW_ON_DEMAND bật (mặc định true) → lazy spawn còn khả dụng */
  onDemand: boolean
}

export interface BridgeState {
  /** offline nhưng vẫn spawn được khi gọi */
  bridgeAsleep: boolean
  /** có thể gọi session-context tool không (online hoặc sẽ tự spawn) */
  bridgeUsable: boolean
  /** accessMode gán cho session-context tools */
  accessMode: BridgeAccessMode
  /** trạng thái runtime thật, để hiển thị + debug */
  bridgeState: BridgeRunState
}

/**
 * Quyết định thuần: online | asleep (on-demand, sẽ tự spawn) | down (hỏng thật).
 * KHÔNG side-effect, KHÔNG gọi ensureBridgeRunning (sẽ phá idle-shutdown
 * và gây spawn loop — xem openclaw-ondemand.ts).
 */
export function resolveBridgeState({ bridgeOnline, onDemand }: BridgeStateInput): BridgeState {
  const bridgeAsleep = !bridgeOnline && onDemand
  const bridgeUsable = bridgeOnline || bridgeAsleep

  return {
    bridgeAsleep,
    bridgeUsable,
    accessMode: bridgeUsable ? 'bridge' : 'unavailable',
    bridgeState: bridgeOnline ? 'online' : bridgeAsleep ? 'asleep' : 'down',
  }
}

/** Ghi chú hiển thị cho UI, dùng chung để /api/tools và /api/tools/registry */
export function bridgeStateNote(bridgeOnline: boolean, bridgeAsleep: boolean, onDemand: boolean): string {
  if (bridgeOnline) return 'gateway-bridge đang chạy — session-context tools sẵn sàng'
  if (bridgeAsleep) {
    return 'gateway-bridge đang ngủ (on-demand) — sẽ tự spawn khi agent gọi tool đầu tiên'
  }
  return onDemand
    ? 'gateway-bridge offline (on-demand) — sẽ thử spawn khi agent gọi tool'
    : 'gateway-bridge offline và on-demand TẮT — session-context tools không dùng được'
}
