/**
 * SESSION TOMBSTONE — chống "hồi sinh" phiên chat đã xóa
 * ====================================
 * (user request 2026-09-08: "các phiên chat tôi đã bấm xóa phải xóa hẳn,
 * lần sau vào lại không còn, chỉ những gì còn học từ đó thì giữ lại")
 *
 * VẤN ĐỀ (root cause): DELETE /api/openclaw/sessions xóa sạch row AgentSession,
 * NHƯNG chat route có 4 chỗ `db.agentSession.upsert({ where: { sessionId } })`
 * — upsert thấy session KHÔNG TỒN TẠI sẽ TẠO MỚI (messageCount tracking).
 * Kịch bản hồi sinh thực tế:
 *   1. User bấm xóa session trong khi frontend vẫn đang giữ sessionId đó
 *      (selected) hoặc đang có request/background-run chạy dở.
 *   2. Request chat tiếp theo (hoặc background task persist) gọi upsert
 *      → session row được TẠO LẠI → reload app thấy session "sống lại".
 *
 * GIẢI PHÁP — 2 LỚP (fix review 2026-09-08):
 *   Lớp 1 (in-process Set — globalThis singleton): check NHANH, 0 I/O.
 *   Lớp 2 (DB table DeletedSession — PERSIST): app restart / Windows reboot /
 *   PM2 restart không mất tombstone — browser tab cũ còn giữ sessionId vẫn
 *   không thể hồi sinh phiên. Trước đây tombstone in-process-only nên restart
 *   là "phiên đã xóa quay lại" (browser tabs outlive processes).
 *
 * API:
 *   - markSessionDeleted(id)      — Set + DB row (fire-and-forget)
 *   - clearSessionTombstone(id)   — Set + DB row (POST create lại cùng id)
 *   - isSessionDeleted(id)        — SYNC, chỉ check Set (hot path, 0 await)
 *   - isSessionDeletedDeep(id)    — ASYNC, Set → miss → DB (write-through vào
 *                                   Set) — dùng cho CỔNG WRITE quan trọng
 *                                   (upsert chat/workflow/cron-run).
 *
 * Hydrate: module-load nạp toàn bộ DeletedSession vào Set (giảm DB hits) —
 * request đến trước khi hydrate xong vẫn đúng nhờ isSessionDeletedDeep query DB.
 */

import { db } from '@/lib/db'

const globalForTombstone = globalThis as unknown as {
  __tmoDeletedSessions?: Set<string>
  __tmoTombstoneHydrated?: Promise<void> | null
}

function tombstoneSet(): Set<string> {
  if (!globalForTombstone.__tmoDeletedSessions) {
    globalForTombstone.__tmoDeletedSessions = new Set<string>()
  }
  return globalForTombstone.__tmoDeletedSessions
}

function addSessionToSet(sessionId: string): void {
  const set = tombstoneSet()
  set.add(sessionId)
  // Bảo vệ bộ nhớ: tombstone là Set chuỗi — cap 2000 entry, xóa cũ nhất (FIFO).
  // (Lớp DB persist vô hạn nên eviction Set không mất dữ liệu — miss sẽ query DB lại)
  if (set.size > 2000) {
    const first = set.values().next().value
    if (first) set.delete(first)
  }
}

/** Nạp tombstone từ DB vào Set — 1 lần mỗi process (fire-and-forget) */
function hydrateFromDb(): Promise<void> {
  if (globalForTombstone.__tmoTombstoneHydrated) return globalForTombstone.__tmoTombstoneHydrated
  globalForTombstone.__tmoTombstoneHydrated = (async () => {
    try {
      const rows = await db.deletedSession.findMany({ select: { sessionId: true } })
      for (const r of rows) addSessionToSet(r.sessionId)
      if (rows.length > 0) {
        console.log(`[Tombstone] Hydrate ${rows.length} session đã-xóa từ DB (persist layer)`)
      }
    } catch (err) {
      // Bảng chưa tồn tại (chưa migrate) hoặc DB bận — isSessionDeletedDeep vẫn query trực tiếp
      console.warn('[Tombstone] Hydrate từ DB thất bại:', err instanceof Error ? err.message : String(err))
    }
  })()
  return globalForTombstone.__tmoTombstoneHydrated
}

// Module-load: bắt đầu hydrate ngay (không chặn ai — fire-and-forget)
void hydrateFromDb()

/**
 * Đánh dấu session đã bị xóa vĩnh viễn — Set in-process + DB row persist.
 * DB write là fire-and-forget (caller DELETE route đã await purge xong —
 * nếu DB write fail hiếm hoi, in-process Set vẫn chặn trong phiên process này).
 */
export function markSessionDeleted(sessionId: string): void {
  if (!sessionId) return
  addSessionToSet(sessionId)
  db.deletedSession
    .upsert({ where: { sessionId }, create: { sessionId }, update: {} })
    .catch(err => {
      console.warn('[Tombstone] Persist DB thất bại (in-process Set vẫn chặn):', err instanceof Error ? err.message : String(err))
    })
}

/** Session này đã bị user xóa? (SYNC — chỉ check Set; cổng write quan trọng dùng isSessionDeletedDeep) */
export function isSessionDeleted(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return tombstoneSet().has(sessionId)
}

/**
 * Session đã bị xóa? (ASYNC — Set trước, DB sau, write-through vào Set).
 * Dùng tại CỔNG WRITE (agentSession.upsert, chatMessage.create, cron action=run,
 * workflow persist) — chặn hồi sinh NGAY CẢ SAU app restart.
 */
export async function isSessionDeletedDeep(sessionId: string | null | undefined): Promise<boolean> {
  if (!sessionId) return false
  if (tombstoneSet().has(sessionId)) return true
  try {
    await hydrateFromDb() // chắc chắn hydrate đã chạy xong (nếu chưa)
    if (tombstoneSet().has(sessionId)) return true
    const row = await db.deletedSession.findUnique({ where: { sessionId }, select: { id: true } })
    if (row) {
      addSessionToSet(sessionId) // write-through — lần sau là hit Set
      return true
    }
  } catch {
    // DB lỗi (chưa migrate / lock) — fail-closed theo Set in-process
  }
  return false
}

/** Xóa tombstone — dùng khi session được tạo lại CÙNG id (POST create) */
export function clearSessionTombstone(sessionId: string): void {
  if (!sessionId) return
  tombstoneSet().delete(sessionId)
  db.deletedSession
    .deleteMany({ where: { sessionId } })
    .catch(() => { /* best-effort */ })
}
