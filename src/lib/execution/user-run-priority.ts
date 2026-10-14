// ============================================
// USER-CHAT RUN PRIORITY — R12 (fix P-NEW-2 lượt quan sát 5, 2026-10-14)
// ============================================
//
// BỐI CẢNH (docs/QUAN-SAT-LUOT-5-R11.md §8.3 P-NEW-2): SelfDirection chạy
// escalation 6 bước (ALISTA→SHOCWAVE→RAMPAGE×2→SENTINEL→Omega) CÙNG LÚC với
// run chat của user đang chờ phản hồi — nguồn áp lực bộ nhớ/tokens song song
// ít được nhìn thấy (đã đo: 2 process opencode ~600MB đồng thời + next-server
// → MemWatchdog self-exit, PM2 restart 9 lần/2.5h).
//
// CƠ CHẾ (R12): khi một run chat của user ĐANG HOẠT ĐỘNG (HTTP request đang
// xử lý — user đang chờ), các bước orchestration SelfDirection TỰ NHƯỢNG:
// chờ trước khi bắt đầu mỗi bước (poll 10s, tối đa SD_USER_RUN_MAX_WAIT_MS).
// Đây là cổng ƯU TIÊN, KHÔNG phải khóa cứng: hết thời gian chờ → orchestration
// vẫn chạy tiếp (semaphore OC-CLI F7 đã serialize spawn — R12 chỉ đổi thứ tự
// ưu tiên cho trải nghiệm user).
//
// TTL USER_RUN_ACTIVE_TTL_MS: lưới an toàn chống flag bị "rò" (request crash
// giữa chừng không clear được — next dev crash path). Sau TTL không thấy hoạt
// động mới → coi như không còn user run. Run chat dài hơn TTL: gate sẽ hết
// kiên nhẫn theo đúng cấu hình — tăng TTL nếu muốn ưu tiên tuyệt đối hơn.

const USER_RUN_ACTIVE_TTL_MS = intEnvMs('USER_RUN_ACTIVE_TTL_MS', 45 * 60_000)
const SD_USER_RUN_MAX_WAIT_MS = intEnvMs('SD_USER_RUN_MAX_WAIT_MS', 10 * 60_000)
const POLL_MS = 10_000

function intEnvMs(name: string, def: number): number {
  const raw = parseInt(process.env[name] || '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : def
}

interface UserChatRunFlag {
  /** Số request chat đang hoạt động (2 request chồng nhau → 2). */
  count: number
  /** Thời điểm request MỚI NHẤT đánh dấu active (TTL tính từ đây). */
  lastMarkAt: number
}

const globalForPriority = globalThis as unknown as {
  __tmoUserChatRunFlag?: UserChatRunFlag
}

/** Đánh dấu: 1 request chat của user bắt đầu xử lý (nếu có). Idempotent an toàn. */
export function markUserChatRunActive(): void {
  const flag = globalForPriority.__tmoUserChatRunFlag
  if (flag) {
    flag.count++
    flag.lastMarkAt = Date.now()
    return
  }
  globalForPriority.__tmoUserChatRunFlag = { count: 1, lastMarkAt: Date.now() }
}

/** Đánh dấu: 1 request chat kết thúc (giảm count — hỗ trợ request chồng nhau). */
export function markUserChatRunDone(): void {
  const flag = globalForPriority.__tmoUserChatRunFlag
  if (!flag) return
  flag.count = Math.max(0, flag.count - 1)
  if (flag.count === 0) delete globalForPriority.__tmoUserChatRunFlag
}

/** Có request chat của user đang hoạt động? (TTL chống flag rò sau crash.) */
export function isUserChatRunActive(): boolean {
  const flag = globalForPriority.__tmoUserChatRunFlag
  if (!flag || flag.count <= 0) return false
  return Date.now() - flag.lastMarkAt < USER_RUN_ACTIVE_TTL_MS
}

export interface WaitResult {
  waitedMs: number
  outcome: 'inactive' | 'clear' | 'timeout'
}

/**
 * Chờ tới khi không còn user-chat run đang hoạt động (hoặc hết maxWaitMs).
 * Log 1 dòng lúc bắt đầu chờ + 1 dòng lúc kết thúc — minh bạch cho người vận
 * hành thấy orchestration đang nhường chỗ cho user.
 * opts.isActive cho test tiêm trạng thái giả (không đụng globalThis thật).
 */
export async function waitForUserChatPriority(
  label: string,
  opts: { maxWaitMs?: number; pollMs?: number; isActive?: () => boolean } = {},
): Promise<WaitResult> {
  const isActive = opts.isActive ?? isUserChatRunActive
  if (!isActive()) return { waitedMs: 0, outcome: 'inactive' }
  const maxWaitMs = opts.maxWaitMs ?? SD_USER_RUN_MAX_WAIT_MS
  const pollMs = Math.max(250, opts.pollMs ?? POLL_MS)
  const startedAt = Date.now()
  console.warn(`[SD-Priority] ${label}: user-chat run đang hoạt động — TẠM NHƯỢNG (P-NEW-2 fix R12), poll mỗi ${Math.round(pollMs / 1000)}s tối đa ${Math.round(maxWaitMs / 1000)}s`)
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, pollMs))
    if (!isActive()) {
      const waitedMs = Date.now() - startedAt
      console.log(`[SD-Priority] ${label}: user-chat run đã xong sau ${Math.round(waitedMs / 1000)}s — orchestration tiếp tục`)
      return { waitedMs, outcome: 'clear' }
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      console.warn(`[SD-Priority] ${label}: chờ đủ ${Math.round(maxWaitMs / 1000)}s mà user run vẫn còn (run dài >TTL?) — TIẾP TỤC (gate là ưu tiên, không phải khóa; semaphore F7 vẫn serialize OC-CLI spawn)`)
      return { waitedMs: Date.now() - startedAt, outcome: 'timeout' }
    }
  }
}
