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
 * GIẢI PHÁP: tombstone in-process (globalThis singleton — app chạy 1 instance
 * PM2). Khi DELETE thành công → markSessionDeleted(sessionId). Mọi nơi định
 * upsert/persist cho sessionId đó → check isSessionDeleted() → SKIP (không
 * tạo lại row, không lưu message). Phiên đã xóa = xóa hẳn.
 *
 * POST /api/openclaw/sessions?action=create → clearSessionTombstone (sessionId
 * mới sinh duy nhất theo timestamp nên gần như không tái sử dụng — nhưng clear
 * cho đúng ngữ nghĩa nếu có recreate thủ công cùng id).
 *
 * Tombstone KHÔNG cần persist xuống DB: DELETE đã hard-delete mọi row của
 * session (chat messages, tasks, working memory...) — không còn dữ liệu nào
 * "nhớ" session cả; tombstone chỉ cần sống đúng tuổi đời của process.
 */

const globalForTombstone = globalThis as unknown as {
  __tmoDeletedSessions?: Set<string>
}

function tombstoneSet(): Set<string> {
  if (!globalForTombstone.__tmoDeletedSessions) {
    globalForTombstone.__tmoDeletedSessions = new Set<string>()
  }
  return globalForTombstone.__tmoDeletedSessions
}

/** Đánh dấu session đã bị xóa vĩnh viễn — mọi write sau này cho session này bị chặn */
export function markSessionDeleted(sessionId: string): void {
  if (!sessionId) return
  tombstoneSet().add(sessionId)
  // Bảo vệ bộ nhớ: tombstone là Set chuỗi — cap 2000 entry, xóa cũ nhất (FIFO)
  const set = tombstoneSet()
  if (set.size > 2000) {
    const first = set.values().next().value
    if (first) set.delete(first)
  }
}

/** Session này đã bị user xóa? (true → KHÔNG upsert/persist nữa) */
export function isSessionDeleted(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false
  return tombstoneSet().has(sessionId)
}

/** Xóa tombstone — dùng khi session được tạo lại CÙNG id (POST create) */
export function clearSessionTombstone(sessionId: string): void {
  if (!sessionId) return
  tombstoneSet().delete(sessionId)
}
