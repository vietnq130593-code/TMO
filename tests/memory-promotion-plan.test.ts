/**
 * Regression tests cho memory-promotion-plan (audit 2026-11)
 *
 * Module này là PURE LOGIC (không import @/lib/db) nên test được không cần DB.
 * Phủ 3 lỗi đã xác định:
 *   D1 — gate tier transitions chặn HOT→WARM
 *   D2 — deleteMany theo session xóa cả bản ghi chưa hết hạn
 *   D3 — backlog lớn hơn take:100 nhưng không có phân trang
 */
import { describe, test, expect } from 'bun:test'
import {
  buildPromotionPlan,
  isExpired,
  shouldRunTierTransitions,
  PROMOTE_PAGE_SIZE,
  PROMOTE_MAX_PAGES,
  type WorkingMemoryRecord,
} from '../src/lib/memory-promotion-plan'

const NOW = new Date('2026-11-01T00:00:00.000Z')
const PAST = new Date('2026-10-01T00:00:00.000Z')
const FUTURE = new Date('2026-12-01T00:00:00.000Z')
const AGENT = 'agent-1'

function rec(id: string, over: Partial<WorkingMemoryRecord> = {}): WorkingMemoryRecord {
  return {
    id,
    agentId: AGENT,
    sessionId: 's1',
    content: `content-${id}`,
    role: 'user',
    expiresAt: PAST,
    ...over,
  }
}

describe('isExpired', () => {
  test('expiresAt null/undefined coi là hết hạn (tránh backlog null bị bỏ sót vô hạn)', () => {
    expect(isExpired({ expiresAt: null }, NOW)).toBe(true)
    expect(isExpired({}, NOW)).toBe(true)
  })

  test('quá khứ = hết hạn, tương lai = chưa', () => {
    expect(isExpired({ expiresAt: PAST }, NOW)).toBe(true)
    expect(isExpired({ expiresAt: FUTURE }, NOW)).toBe(false)
  })

  test('đúng bằng now cũng hết hạn (<=)', () => {
    expect(isExpired({ expiresAt: NOW }, NOW)).toBe(true)
  })
})

describe('D1 — shouldRunTierTransitions', () => {
  test('trả true khi không có gì decayed/deactivated (HOT→WARM không bị gate bỏ qua)', () => {
    expect(shouldRunTierTransitions({ decayed: 0, deactivated: 0 })).toBe(true)
  })

  test('trả true khi có việc', () => {
    expect(shouldRunTierTransitions({ decayed: 3, deactivated: 0 })).toBe(true)
    expect(shouldRunTierTransitions({ decayed: 0, deactivated: 2 })).toBe(true)
  })
})

describe('D3 — hằng số phân trang có giới hạn', () => {
  test('page size và max pages là hằng số hữu hạn, backend không đổi hành vi quota cũ', () => {
    expect(PROMOTE_PAGE_SIZE).toBe(100)
    expect(PROMOTE_MAX_PAGES).toBe(10)
    expect(PROMOTE_MAX_PAGES * PROMOTE_PAGE_SIZE).toBe(1000)
  })
})

describe('D2 — chỉ xóa bản ghi đã hết hạn, đúng id cụ thể', () => {
  test('bản ghi chưa hết hạn KHÔNG nằm trong deletableIds, được trả về deferredIds', () => {
    const plan = buildPromotionPlan(
      [rec('a', { expiresAt: PAST }), rec('b', { expiresAt: FUTURE })],
      { agentId: AGENT, now: NOW }
    )
    expect(plan.deferredIds).toEqual(['b'])
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0].deletableIds).toEqual(['a'])
  })

  test('một session lẫn lộn expired + live chỉ xóa đúng phần expired', () => {
    const plan = buildPromotionPlan(
      [
        rec('u1', { role: 'user' }),
        rec('a1', { role: 'assistant' }),
        rec('live', { role: 'user', expiresAt: FUTURE }),
      ],
      { agentId: AGENT, now: NOW }
    )
    const ids = plan.groups.flatMap(g => g.deletableIds).sort()
    expect(ids).toEqual(['a1', 'u1'])
    expect(plan.deferredIds).toEqual(['live'])
  })

  test('bản ghi của agent khác bị bỏ qua hoàn toàn (không vào deletable lẫn deferred)', () => {
    const plan = buildPromotionPlan([rec('x', { agentId: 'agent-2' })], {
      agentId: AGENT,
      now: NOW,
    })
    expect(plan.totalIn).toBe(1)
    expect(plan.totalDeletable).toBe(0)
    expect(plan.deferredIds).toEqual([])
  })

  test('đường gọi theo session chỉ giữ bản ghi của session đó', () => {
    const plan = buildPromotionPlan([rec('x', { sessionId: 's1' }), rec('y', { sessionId: 's2' })], {
      agentId: AGENT,
      now: NOW,
      sessionId: 's1',
    })
    expect(plan.groups.map(g => g.sessionId)).toEqual(['s1'])
    expect(plan.groups[0].deletableIds).toEqual(['x'])
  })
})

describe('extraction gate', () => {
  test('cần đủ user + assistant mới gọi LLM trích xuất', () => {
    const plan = buildPromotionPlan([rec('u', { role: 'user' })], { agentId: AGENT, now: NOW })
    expect(plan.totalNeedsExtraction).toBe(0)
  })

  test('system-only group vẫn deletable nhưng không gọi LLM (TTL đã hết hạn)', () => {
    const plan = buildPromotionPlan(
      [rec('s1', { role: 'system' }), rec('s2', { role: 'system' })],
      { agentId: AGENT, now: NOW }
    )
    expect(plan.totalDeletable).toBe(2)
    expect(plan.totalNeedsExtraction).toBe(0)
  })

  test('đủ cặp user + assistant thì needsExtraction true và gom đúng nội dung', () => {
    const plan = buildPromotionPlan(
      [
        rec('u1', { role: 'user', content: 'câu hỏi' }),
        rec('u2', { role: 'user', content: 'câu hỏi 2' }),
        rec('a1', { role: 'assistant', content: 'trả lời' }),
      ],
      { agentId: AGENT, now: NOW }
    )
    expect(plan.totalNeedsExtraction).toBe(1)
    const g = plan.groups[0]
    expect(g.userMsgs).toBe('câu hỏi\ncâu hỏi 2')
    expect(g.assistantMsgs).toBe('trả lời')
    expect(g.recordCount).toBe(3)
  })
})

describe('phân trang — mỗi lượt tiến được', () => {
  test('deletableIds của trang sau không trùng trang trước khi áp dụng notIn (mô phỏng 2 lượt)', () => {
    const page1 = Array.from({ length: PROMOTE_PAGE_SIZE }, (_, i) => rec(`p1-${i}`, {
      role: i % 2 === 0 ? 'user' : 'assistant',
    }))
    const plan1 = buildPromotionPlan(page1, { agentId: AGENT, now: NOW })
    expect(plan1.totalDeletable).toBe(PROMOTE_PAGE_SIZE)

    const handled = new Set(plan1.groups.flatMap(g => g.deletableIds))
    const page2 = Array.from({ length: 50 }, (_, i) => rec(`p2-${i}`, {
      role: i % 2 === 0 ? 'user' : 'assistant',
    }))
    const plan2 = buildPromotionPlan(page2, { agentId: AGENT, now: NOW })
    for (const id of plan2.groups.flatMap(g => g.deletableIds)) {
      expect(handled.has(id)).toBe(false)
    }
    expect(plan2.totalDeletable).toBe(50)
  })
})
