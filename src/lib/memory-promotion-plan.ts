/**
 * Memory Promotion Plan — PURE LOGIC (audit 2026-11)
 *
 * Tách ra khỏi memory-tiers.ts để:
 *   1. Test được bằng bun test mà KHÔNG cần Prisma/DB (import không kéo theo @/lib/db).
 *   2. Khoanh vùng rõ quy tắc "bản ghi nào được xóa, bản ghi nào được trích xuất".
 *
 * Bug gốc đã sửa (D2):
 *   promoteWorkingMemoryToWarm() gọi db.workingMemory.deleteMany({ agentId, sessionId })
 *   trong khi chỉ fetch take:100 theo expiresAt. Hệ quả: mọi bản ghi CÙNG session —
 *   kể cả bản ghi CHƯA hết hạn và bản ghi nằm ngoài take:100 — đều bị xóa vĩnh viễn.
 *
 * Quy tắc mới:
 *   - CHỈ bản ghi ĐÃ hết hạn mới đủ điều kiện bị xóa.
 *   - CHỈ xóa theo id cụ thể của bản ghi vừa lấy về (deletableIds), không xóa cả session.
 *   - Bản ghi chưa hết hạn được trả về dưới dạng deferredIds để caller giữ lại.
 */

/** Số bản ghi đọc mỗi lượt (giữ nguyên giá trị cũ để không đổi hành vi quota) */
export const PROMOTE_PAGE_SIZE = 100

/** Số lượt tối đa mỗi lần gọi — chặn vòng lặp vô hạn khi backlog lớn */
export const PROMOTE_MAX_PAGES = 10

export interface WorkingMemoryRecord {
  id: string
  agentId: string
  sessionId: string
  content: string
  role: string
  expiresAt?: Date | null
}

export interface PromotionGroup {
  sessionId: string
  /** id được phép xóa — bản ghi đã hết hạn VÀ đã nằm trong trang vừa đọc */
  deletableIds: string[]
  userMsgs: string
  assistantMsgs: string
  /** chỉ true khi có đủ cặp user + assistant để gọi LLM trích xuất */
  needsExtraction: boolean
  recordCount: number
}

export interface PromotionPlan {
  groups: PromotionGroup[]
  /** id bản ghi chưa hết hạn — caller KHÔNG được xóa */
  deferredIds: string[]
  totalIn: number
  totalDeletable: number
  totalNeedsExtraction: number
}

export interface BuildPlanInput {
  agentId: string
  now: Date
  /** khi set, chỉ giữ bản ghi của session này (đường dẫn gọi theo session) */
  sessionId?: string
}

/**
 * Bản ghi hết hạn = không có expiresAt (null/undefined) HOẶC expiresAt <= now.
 * Trước đây query dùng `expiresAt: { lt: now }` nên bản ghi null bị bỏ sót vô hạn;
 * ở đây coi null là hết hạn để backlog có thể drain được.
 */
export function isExpired(rec: { expiresAt?: Date | null }, now: Date): boolean {
  if (!rec.expiresAt) return true
  return rec.expiresAt.getTime() <= now.getTime()
}

/**
 * Xây kế hoạch promote cho 1 trang bản ghi. Hàm thuần — không DB, không Date.now().
 */
export function buildPromotionPlan(
  records: WorkingMemoryRecord[],
  input: BuildPlanInput
): PromotionPlan {
  const { agentId, now, sessionId } = input
  const deferredIds: string[] = []
  const bySession = new Map<string, WorkingMemoryRecord[]>()

  for (const rec of records) {
    if (rec.agentId !== agentId) continue
    if (sessionId && rec.sessionId !== sessionId) continue
    if (!isExpired(rec, now)) {
      deferredIds.push(rec.id)
      continue
    }
    const arr = bySession.get(rec.sessionId) || []
    arr.push(rec)
    bySession.set(rec.sessionId, arr)
  }

  const groups: PromotionGroup[] = []
  for (const [sessId, mems] of bySession) {
    const userMsgs = mems.filter(m => m.role === 'user').map(m => m.content).join('\n')
    const assistantMsgs = mems.filter(m => m.role === 'assistant').map(m => m.content).join('\n')
    groups.push({
      sessionId: sessId,
      deletableIds: mems.map(m => m.id),
      userMsgs,
      assistantMsgs,
      needsExtraction: Boolean(userMsgs && assistantMsgs),
      recordCount: mems.length,
    })
  }

  const totalDeletable = groups.reduce((n, g) => n + g.deletableIds.length, 0)

  return {
    groups,
    deferredIds,
    totalIn: records.length,
    totalDeletable,
    totalNeedsExtraction: groups.filter(g => g.needsExtraction).length,
  }
}

/**
 * D1 — cờ chặn `deactivated > 0` khiến promote/archive/cleanup không bao giờ chạy
 * khi không có memory WARM nào bị deactive. Trả về true LUÔN: 3 transition đều
 * bounded (page cap / threshold) + idempotent, nên "bỏ qua khi không có việc"
 * chỉ tốn 1 vòng query rẻ mà đổi lại là backlog HOT không bao giờ được dọn.
 *
 * Giữ hàm này (thay vì xóa luôn điều kiện) để có chỗ neo cho regression test.
 */
export function shouldRunTierTransitions(input: { decayed: number; deactivated: number }): boolean {
  void input
  return true
}
