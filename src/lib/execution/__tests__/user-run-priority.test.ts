// ============================================
// R12 — Unit test USER-CHAT RUN PRIORITY (src/lib/execution/user-run-priority.ts)
// Fix P-NEW-2 lượt quan sát 5: SelfDirection nhường chỗ khi user chat đang chờ.
// ============================================

import { afterEach, describe, expect, test } from 'bun:test'
import {
  isUserChatRunActive,
  markUserChatRunActive,
  markUserChatRunDone,
  waitForUserChatPriority,
} from '../user-run-priority'

/** Dọn globalThis flag sau mỗi test — test độc lập tuyệt đối. */
afterEach(() => {
  const g = globalThis as unknown as { __tmoUserChatRunFlag?: { count: number } }
  delete g.__tmoUserChatRunFlag
})

describe('USER-CHAT RUN PRIORITY — flag mark/done (R12)', () => {
  test('mặc định không active', () => {
    expect(isUserChatRunActive()).toBe(false)
  })

  test('mark → active; done → tắt', () => {
    markUserChatRunActive()
    expect(isUserChatRunActive()).toBe(true)
    markUserChatRunDone()
    expect(isUserChatRunActive()).toBe(false)
  })

  test('done khi chưa mark là no-op (đường finally của request lỗi sớm)', () => {
    expect(() => markUserChatRunDone()).not.toThrow()
    expect(isUserChatRunActive()).toBe(false)
  })

  test('2 request chồng nhau: tắt sau đúng 2 lần done (counter, không phải boolean)', () => {
    markUserChatRunActive()
    markUserChatRunActive()
    expect(isUserChatRunActive()).toBe(true)
    markUserChatRunDone() // request 1 xong — request 2 vẫn chạy
    expect(isUserChatRunActive()).toBe(true)
    markUserChatRunDone() // request 2 xong
    expect(isUserChatRunActive()).toBe(false)
  })

  test('done thừa (crash path gọi finally 2 lần) không âm count', () => {
    markUserChatRunActive()
    markUserChatRunDone()
    markUserChatRunDone() // thừa — không được xuống âm
    markUserChatRunActive() // mark sau khi đã tắt vẫn hoạt động
    expect(isUserChatRunActive()).toBe(true)
  })
})

describe('USER-CHAT RUN PRIORITY — waitForUserChatPriority (R12)', () => {
  test('isActive=false ngay đầu → outcome inactive, 0ms', async () => {
    const r = await waitForUserChatPriority('test-bước', {
      isActive: () => false,
      pollMs: 20,
      maxWaitMs: 100,
    })
    expect(r.outcome).toBe('inactive')
    expect(r.waitedMs).toBe(0)
  })

  test('user run xong giữa chừng → outcome clear (orchestration tiếp tục)', async () => {
    let active = true
    let polls = 0
    const r = await waitForUserChatPriority('test-bước', {
      isActive: () => {
        polls++
        if (polls >= 2) active = false // user run kết thúc sau poll thứ 2
        return active
      },
      pollMs: 20,
      maxWaitMs: 2_000,
    })
    expect(r.outcome).toBe('clear')
    expect(polls).toBeGreaterThanOrEqual(2)
    expect(r.waitedMs).toBeGreaterThan(0)
  })

  test('user run dai dẳng → outcome timeout (gate là ưu tiên, không khóa cứng)', async () => {
    const r = await waitForUserChatPriority('test-bước', {
      isActive: () => true, // user run luôn còn
      pollMs: 20,
      maxWaitMs: 80,
    })
    expect(r.outcome).toBe('timeout')
    expect(r.waitedMs).toBeGreaterThanOrEqual(80)
  })
})
