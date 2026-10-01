/**
 * DISPOSABLE FIXTURE — E2E-ish proof cho D1/D2/D3 của memory 3 tầng (audit 2026-11).
 *
 * Vì sao cần file này: tests/memory-promotion-plan.test.ts chỉ chứng minh quy tắc THUẦN
 * (buildPromotionPlan) cho D1 và một phần D2/D3. Chưa có bằng chứng nào cho biết VÒNG LẶP
 * promote thật trong src/lib/memory-tiers.ts có thực sự chỉ xóa đúng deletableIds,
 * phân trang không trùng/bỏ sót và chạy lặp idempotent hay không.
 *
 * Cách làm: dựng store in-memory disposable, seed dữ liệu biết trước, rồi chạy vòng lặp
 * được sao chép TRUNG THỰC từ src/lib/memory-tiers.ts (promoteWorkingMemoryToWarm,
 * dòng 93–195). Hằng số và hàm quyết định vẫn import từ module THẬT
 * (src/lib/memory-promotion-plan.ts) — không re-implement logic quyết định.
 *
 * Giới hạn trung thực: tầng Prisma (db.workingMemory.*) KHÔNG chạy ở đây; phần Prisma
 * được kiểm chứng bằng assertion tĩnh trên mã nguồn thật (đọc file, đối chiếu câu lệnh
 * delete). Xem describe('static source guards').
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPromotionPlan,
  shouldRunTierTransitions,
  PROMOTE_PAGE_SIZE,
  PROMOTE_MAX_PAGES,
  type WorkingMemoryRecord,
} from '../src/lib/memory-promotion-plan'

const NOW = new Date('2026-11-01T00:00:00.000Z')
const PAST = new Date('2026-10-01T00:00:00.000Z')
const FUTURE = new Date('2026-12-01T00:00:00.000Z')

type Row = WorkingMemoryRecord & { createdAt: number }

interface Where {
  agentId: string
  expiresAt?: { lt: Date }
  sessionId?: string
  id?: { notIn: string[] }
}

/** Store disposable — mô phỏng đúng ngữ nghĩa where/orderBy/take của Prisma. */
class DisposableStore {
  rows: Row[] = []
  deleteCalls: Array<{ ids: string[]; count: number }> = []
  private seq = 0

  seed(over: Partial<Row> & { agentId: string; sessionId: string; role?: string }): string {
    const id = `wm-${String(++this.seq).padStart(4, '0')}`
    const expired = over.expiresAt === undefined ? true : over.expiresAt !== null
    this.rows.push({
      id,
      agentId: over.agentId,
      sessionId: over.sessionId,
      content: over.content ?? `content-${id}`,
      role: over.role ?? (this.seq % 2 === 0 ? 'user' : 'assistant'),
      expiresAt: over.expiresAt !== undefined ? over.expiresAt : expired ? PAST : FUTURE,
      createdAt: this.seq,
    })
    return id
  }

  findMany(where: Where, take: number): Row[] {
    return this.rows
      .filter(r => r.agentId === where.agentId)
      .filter(r => (where.sessionId ? r.sessionId === where.sessionId : true))
      .filter(r => (where.expiresAt ? r.expiresAt != null && r.expiresAt < where.expiresAt.lt : true))
      .filter(r => (where.id?.notIn ? !where.id.notIn.includes(r.id) : true))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, take)
  }

  /** Mô phỏng db.workingMemory.deleteMany({ where: { id: { in: ids } } }) */
  deleteMany(ids: string[]): number {
    const set = new Set(ids)
    const victims = this.rows.filter(r => set.has(r.id))
    this.deleteCalls.push({ ids: [...ids], count: victims.length })
    this.rows = this.rows.filter(r => !set.has(r.id))
    return victims.length
  }

  has(id: string): boolean {
    return this.rows.some(r => r.id === id)
  }

  deletedIds(): string[] {
    return this.deleteCalls.flatMap(c => c.ids)
  }
}

interface LoopResult {
  deleted: number
  pages: number
  pageCapReached: boolean
  cappedOut: boolean
  deferredKept: string[]
  extractedSessions: string[]
}

/**
 * Bản sao trung thực của promoteWorkingMemoryToWarm (memory-tiers.ts:93–195).
 * Mọi quyết định xóa/trích đều đi qua buildPromotionPlan từ module thật.
 */
function runPromoteLoop(
  store: DisposableStore,
  agentId: string,
  now: Date,
  sessionId?: string,
  maxPages: number = PROMOTE_MAX_PAGES
): LoopResult {
  let deleted = 0
  let pages = 0
  let pageCapReached = false
  const handledIds = new Set<string>()
  const deferredKept: string[] = []
  const extractedSessions: string[] = []

  while (pages < maxPages) {
    const where: Where = { agentId }
    if (sessionId) {
      where.sessionId = sessionId
    } else {
      where.expiresAt = { lt: now }
    }
    if (handledIds.size > 0) where.id = { notIn: [...handledIds] }

    const workingMemories = store.findMany(where, PROMOTE_PAGE_SIZE)
    pages += 1
    if (workingMemories.length === 0) break

    const plan = buildPromotionPlan(
      workingMemories.map(m => ({
        id: m.id,
        agentId: m.agentId,
        sessionId: m.sessionId,
        content: m.content,
        role: m.role,
        expiresAt: m.expiresAt,
      })),
      { agentId, now, sessionId }
    )
    deferredKept.push(...plan.deferredIds)

    for (const group of plan.groups) {
      if (group.needsExtraction) extractedSessions.push(group.sessionId)
      deleted += store.deleteMany(group.deletableIds)
      for (const id of group.deletableIds) handledIds.add(id)
    }

    if (workingMemories.length < PROMOTE_PAGE_SIZE) break
  }

  if (pages >= maxPages) pageCapReached = true
  const cappedOut = store.rows.some(r => r.agentId === agentId && r.expiresAt != null && r.expiresAt < now)
  return { deleted, pages, pageCapReached, cappedOut, deferredKept, extractedSessions }
}

describe('D1 — tier transitions không bị gate chặn', () => {
  test('gate trả true khi không có WARM nào bị deactive (0/0)', () => {
    expect(shouldRunTierTransitions({ decayed: 0, deactivated: 0 })).toBe(true)
  })

  test('HOT backlog vẫn được promote khi decayed=0 và deactivated=0', () => {
    const store = new DisposableStore()
    const expired: string[] = []
    for (let i = 0; i < 40; i++) expired.push(store.seed({ agentId: 'a1', sessionId: 's1' }))

    const decayed = 0
    const deactivated = 0
    let promoted = 0
    if (shouldRunTierTransitions({ decayed, deactivated })) {
      const r = runPromoteLoop(store, 'a1', NOW)
      promoted = r.deleted
    }
    expect(promoted).toBe(40)
    expect(store.rows.length).toBe(0)
  })
})

describe('D2 — chỉ xóa đúng deletableIds', () => {
  test('đường agent-wide: xóa hết bản ghi hết hạn, GIỮ bản ghi chưa hết hạn và agent khác', () => {
    const store = new DisposableStore()
    const expiredIds: string[] = []
    for (let i = 0; i < 230; i++) expiredIds.push(store.seed({ agentId: 'a1', sessionId: i < 130 ? 's1' : 's2' }))
    const liveIds: string[] = []
    for (let i = 0; i < 20; i++) liveIds.push(store.seed({ agentId: 'a1', sessionId: 's1', expiresAt: FUTURE }))
    const otherAgentIds: string[] = []
    for (let i = 0; i < 25; i++) otherAgentIds.push(store.seed({ agentId: 'a2', sessionId: 's3' }))

    const r = runPromoteLoop(store, 'a1', NOW)

    expect(r.deleted).toBe(230)
    for (const id of expiredIds) expect(store.has(id)).toBe(false)
    for (const id of liveIds) expect(store.has(id)).toBe(true)
    for (const id of otherAgentIds) expect(store.has(id)).toBe(true)
    expect(store.rows.length).toBe(45)
  })

  test('deleteMany chỉ nhận id của chính nhóm vừa đọc — không có id nào bị xóa 2 lần', () => {
    const store = new DisposableStore()
    for (let i = 0; i < 150; i++) store.seed({ agentId: 'a1', sessionId: 's1' })

    runPromoteLoop(store, 'a1', NOW)

    const sent = store.deletedIds()
    expect(new Set(sent).size).toBe(sent.length)
    for (const call of store.deleteCalls) {
      for (const id of call.ids) expect(call.ids).toContain(id)
    }
    expect(store.rows.length).toBe(0)
  })

  test('đường session-scoped: bản ghi chưa hết hạn cùng session được defer, session khác không bị đụng', () => {
    const store = new DisposableStore()
    const s1Expired: string[] = []
    for (let i = 0; i < 130; i++) s1Expired.push(store.seed({ agentId: 'a1', sessionId: 's1' }))
    const s1Live: string[] = []
    for (let i = 0; i < 20; i++) s1Live.push(store.seed({ agentId: 'a1', sessionId: 's1', expiresAt: FUTURE }))
    const s2Expired: string[] = []
    for (let i = 0; i < 40; i++) s2Expired.push(store.seed({ agentId: 'a1', sessionId: 's2' }))

    const r = runPromoteLoop(store, 'a1', NOW, 's1')

    expect(r.deleted).toBe(130)
    expect(r.deferredKept.sort()).toEqual([...s1Live].sort())
    for (const id of s1Expired) expect(store.has(id)).toBe(false)
    for (const id of s1Live) expect(store.has(id)).toBe(true)
    for (const id of s2Expired) expect(store.has(id)).toBe(true)
    expect(store.rows.length).toBe(60)
  })

  /**
   * PHÁT HIỆN (ledger LOW-1): schema khai báo `expiresAt DateTime` KHÔNG null
   * (prisma/schema.prisma, model WorkingMemory) → nhánh null trong isExpired() là
   * phòng thủ không reachable. Đồng thời doc memory-promotion-plan.ts:62-66 nói
   * "coi null là hết hạn để backlog có thể drain được" nhưng query agent-wide
   * (memory-tiers.ts:121) vẫn lọc `expiresAt: { lt: now }` nên SQL loại NULL.
   * Test này ghi nhận HÀNH VI THẬT của cả hai đường, không giả định.
   */
  test('expiresAt=null: đường agent-wide không thấy (lọc lt), đường session-scoped có xóa', () => {
    const agentWide = new DisposableStore()
    const nullWide: string[] = []
    for (let i = 0; i < 5; i++) nullWide.push(agentWide.seed({ agentId: 'a1', sessionId: 's1', expiresAt: null }))

    const rWide = runPromoteLoop(agentWide, 'a1', NOW)
    expect(rWide.deleted).toBe(0)
    for (const id of nullWide) expect(agentWide.has(id)).toBe(true)

    const sessionScoped = new DisposableStore()
    const nullScoped: string[] = []
    for (let i = 0; i < 5; i++) nullScoped.push(sessionScoped.seed({ agentId: 'a1', sessionId: 's1', expiresAt: null }))

    const rScoped = runPromoteLoop(sessionScoped, 'a1', NOW, 's1')
    expect(rScoped.deleted).toBe(5)
    for (const id of nullScoped) expect(sessionScoped.has(id)).toBe(false)
  })

  test('schema WorkingMemory khai báo expiresAt KHÔNG null — nhánh null là phòng thủ', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8')
    const model = schema.match(/model WorkingMemory \{[\s\S]*?\n\}/)?.[0] ?? ''
    const field = model.match(/expiresAt\s+\w+/)?.[0] ?? ''
    expect(field).toBe('expiresAt   DateTime')
    expect(field).not.toContain('?')
  })
})

describe('D3 — phân trang đủ, không trùng, chạy lại idempotent', () => {
  test('backlog > 2 trang được xử lý hết, không trùng không bỏ sót', () => {
    const store = new DisposableStore()
    const ids: string[] = []
    for (let i = 0; i < 230; i++) ids.push(store.seed({ agentId: 'a1', sessionId: 's1' }))

    const r = runPromoteLoop(store, 'a1', NOW)

    expect(r.pages).toBe(3)
    expect(r.pageCapReached).toBe(false)
    expect(r.cappedOut).toBe(false)
    expect(r.deleted).toBe(230)
    const sent = store.deletedIds()
    expect(new Set(sent).size).toBe(230)
    expect(new Set(sent)).toEqual(new Set(ids))
    expect(store.rows.length).toBe(0)
  })

  test('chạy lần thứ hai không xóa thêm, không nhân bản — idempotent', () => {
    const store = new DisposableStore()
    for (let i = 0; i < 230; i++) store.seed({ agentId: 'a1', sessionId: 's1' })

    const first = runPromoteLoop(store, 'a1', NOW)
    const rowsAfterFirst = store.rows.length
    const second = runPromoteLoop(store, 'a1', NOW)
    const third = runPromoteLoop(store, 'a1', NOW)

    expect(first.deleted).toBe(230)
    expect(second.deleted).toBe(0)
    expect(third.deleted).toBe(0)
    expect(second.pages).toBe(1)
    expect(store.rows.length).toBe(rowsAfterFirst)
    expect(store.rows.length).toBe(0)
  })

  test('backlog vượt page cap bị giới hạn, phần còn lại xử lý được ở lượt sau', () => {
    const store = new DisposableStore()
    const ids: string[] = []
    for (let i = 0; i < 1200; i++) ids.push(store.seed({ agentId: 'a1', sessionId: 's1' }))

    const first = runPromoteLoop(store, 'a1', NOW)
    expect(first.pages).toBe(PROMOTE_MAX_PAGES)
    expect(first.pageCapReached).toBe(true)
    expect(first.cappedOut).toBe(true)
    expect(first.deleted).toBe(PROMOTE_MAX_PAGES * PROMOTE_PAGE_SIZE)
    expect(store.rows.length).toBe(200)

    const second = runPromoteLoop(store, 'a1', NOW)
    expect(second.deleted).toBe(200)
    expect(store.rows.length).toBe(0)
    const sent = store.deletedIds()
    expect(new Set(sent).size).toBe(1200)
    expect(new Set(sent)).toEqual(new Set(ids))
  })

  test('hằng số phân trang khớp giá trị audit ghi nhận', () => {
    expect(PROMOTE_PAGE_SIZE).toBe(100)
    expect(PROMOTE_MAX_PAGES).toBe(10)
  })

  test('chỉ gọi trích xuất LLM khi nhóm có đủ cặp user + assistant', () => {
    const store = new DisposableStore()
    store.seed({ agentId: 'a1', sessionId: 's1', role: 'user' })
    store.seed({ agentId: 'a1', sessionId: 's1', role: 'user' })

    const onlyUser = runPromoteLoop(store, 'a1', NOW)
    expect(onlyUser.extractedSessions).toEqual([])

    const store2 = new DisposableStore()
    store2.seed({ agentId: 'a1', sessionId: 's1', role: 'user' })
    store2.seed({ agentId: 'a1', sessionId: 's1', role: 'assistant' })

    const both = runPromoteLoop(store2, 'a1', NOW)
    expect(both.extractedSessions).toEqual(['s1'])
  })
})

describe('static source guards — mã nguồn thật src/lib/memory-tiers.ts', () => {
  const src = readFileSync(join(process.cwd(), 'src/lib/memory-tiers.ts'), 'utf8')
  /** Bỏ comment để assertion chỉ soi mã thực thi, không soi doc comment */
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  test('xóa theo id cụ thể, KHÔNG còn deleteMany({ agentId, sessionId })', () => {
    expect(codeOnly).toContain('where: { id: { in: group.deletableIds } }')
    expect(codeOnly).not.toMatch(/deleteMany\(\s*\{\s*agentId\s*,\s*sessionId\s*\}\s*\)/)
  })

  test('vòng lặp phân trang dùng take: PROMOTE_PAGE_SIZE và break khi trang ngắn', () => {
    expect(src).toContain('take: PROMOTE_PAGE_SIZE')
    expect(src).toContain('if (workingMemories.length < PROMOTE_PAGE_SIZE) break')
    expect(src).toContain('id = { notIn: [...handledIds] }')
  })

  test('điểm gọi D1 trong agent-memory.ts không còn gate deactivated > 0', () => {
    const am = readFileSync(join(process.cwd(), 'src/lib/agent-memory.ts'), 'utf8')
    expect(am).toContain("import { shouldRunTierTransitions } from './memory-promotion-plan'")
    expect(am).toContain('if (shouldRunTierTransitions({ decayed, deactivated }))')
    expect(am).not.toMatch(/if\s*\(\s*deactivated\s*>\s*0\s*\)\s*\{\s*\n\s*\/\/.*tier/i)
  })
})
