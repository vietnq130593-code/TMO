// ============================================================================
// TEST SUITE — BRIDGE STATE (resolveBridgeState)
// Regression cho bug: GET /api/tools coi gateway-bridge đang NGỦ (on-demand
// idle-shutdown) là "unavailable", làm accessibleTotal giảm 85→67 dù 18 tool
// gọi là spawn được ngay.
//
// Bối cảnh: commit c1129d3 sửa route; test này khóa hành vi đó ở tầng hàm
// thuần nên route đổi cách gọi (inline ↔ helper) vẫn không hồi quy.
//
// Chạy: cd /home/z/tmo-app && bun test tests/bridge-state.test.ts
// ============================================================================

import { describe, test, expect } from 'bun:test'
import { resolveBridgeState, bridgeStateNote } from '../src/lib/bridge-state'

describe('resolveBridgeState — bridge đang chạy', () => {
  test('online + on-demand bật → online, usable, accessMode bridge', () => {
    const s = resolveBridgeState({ bridgeOnline: true, onDemand: true })
    expect(s.bridgeAsleep).toBe(false)
    expect(s.bridgeUsable).toBe(true)
    expect(s.accessMode).toBe('bridge')
    expect(s.bridgeState).toBe('online')
  })

  test('online + on-demand tắt → vẫn online, KHÔNG coi là asleep', () => {
    const s = resolveBridgeState({ bridgeOnline: true, onDemand: false })
    expect(s.bridgeAsleep).toBe(false)
    expect(s.bridgeUsable).toBe(true)
    expect(s.accessMode).toBe('bridge')
    expect(s.bridgeState).toBe('online')
  })
})

describe('resolveBridgeState — bridge offline (nhánh bug cũ)', () => {
  test('offline + on-demand BẬT → asleep, VẪN usable (không hỏng thật)', () => {
    const s = resolveBridgeState({ bridgeOnline: false, onDemand: true })
    expect(s.bridgeAsleep).toBe(true)
    expect(s.bridgeUsable).toBe(true)
    expect(s.accessMode).toBe('bridge')
    expect(s.bridgeState).toBe('asleep')
  })

  test('offline + on-demand TẮT → down, KHÔNG usable, unavailable', () => {
    const s = resolveBridgeState({ bridgeOnline: false, onDemand: false })
    expect(s.bridgeAsleep).toBe(false)
    expect(s.bridgeUsable).toBe(false)
    expect(s.accessMode).toBe('unavailable')
    expect(s.bridgeState).toBe('down')
  })
})

describe('resolveBridgeState — bất biến quan trọng', () => {
  test('bridgeAsleep chỉ khi offline (online không bao giờ asleep)', () => {
    expect(resolveBridgeState({ bridgeOnline: true, onDemand: true }).bridgeAsleep).toBe(false)
    expect(resolveBridgeState({ bridgeOnline: true, onDemand: false }).bridgeAsleep).toBe(false)
  })

  test('bridgeUsable === (online || asleep) cho cả 4 tổ hợp', () => {
    for (const bridgeOnline of [true, false]) {
      for (const onDemand of [true, false]) {
        const s = resolveBridgeState({ bridgeOnline, onDemand })
        expect(s.bridgeUsable).toBe(bridgeOnline || (!bridgeOnline && onDemand))
        expect(s.accessMode === 'unavailable').toBe(!s.bridgeUsable)
      }
    }
  })

  test('offline+onDemand đánh dấu asleep KHÁC down — phân biệt ngủ vs hỏng', () => {
    const asleep = resolveBridgeState({ bridgeOnline: false, onDemand: true })
    const down = resolveBridgeState({ bridgeOnline: false, onDemand: false })
    expect(asleep.bridgeState).not.toBe(down.bridgeState)
    expect(asleep.accessMode).not.toBe(down.accessMode)
  })

  test('hàm thuần: gọi lại nhiều lần cho kết quả giống hệt (không side-effect)', () => {
    const input = { bridgeOnline: false, onDemand: true }
    const a = resolveBridgeState(input)
    const b = resolveBridgeState(input)
    const c = resolveBridgeState(input)
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })

  test('không gọi ensureBridgeRunning — hàm không side-effect, không await', () => {
    // resolveBridgeState là hàm đồng bộ: nếu lỡ thành async sẽ trả Promise
    const s = resolveBridgeState({ bridgeOnline: false, onDemand: true })
    expect(s).not.toBeInstanceOf(Promise)
    expect(typeof s.bridgeUsable).toBe('boolean')
  })
})

describe('bridgeStateNote — note cho UI', () => {
  test('online → note nói đang chạy', () => {
    const n = bridgeStateNote(true, false, true)
    expect(n).toContain('đang chạy')
  })

  test('asleep → note giải thích sẽ tự spawn (không phải lỗi)', () => {
    const n = bridgeStateNote(false, true, true)
    expect(n).toContain('ngủ')
    expect(n).toContain('spawn')
  })

  test('down + on-demand tắt → note cảnh báo không dùng được', () => {
    const n = bridgeStateNote(false, false, false)
    expect(n).toContain('không dùng được')
  })
})
